/**
 * Routes inbound mail to one harness session per email thread.
 *
 * There is no mapping store. The session id is a total function of the thread
 * id, and a session that does not exist yet rebuilds itself from
 * `threads.get` — AgentMail is the source of truth, so disposal is
 * non-destructive and a lost session costs a rehydration, nothing more.
 * @module dsh-agentmail/threads
 */
import type { Config } from './config.js'
import { sessionIdFor } from './naming.js'

/** The agent surface this module needs. Narrow on purpose, so it can be faked. */
export interface InjectableAgent {
  inject(text: string): void
  followup(text: string): void
}

/** An owned agent plus its teardown. */
export interface OwnedAgent {
  agent: InjectableAgent
  dispose(): Promise<void> | void
}

/**
 * The session operations the router drives. Implemented over `ctx.agents` in
 * {@link ../inbound.ts}, and faked directly in tests.
 */
export interface SessionPort {
  /** A live agent for this session id, if one is running. */
  get(sessionId: string): InjectableAgent | undefined
  /** Whether a persisted session log exists for this id. */
  exists(sessionId: string): Promise<boolean>
  /** Create a fresh agent on this session id. */
  create(sessionId: string): Promise<OwnedAgent>
  /** Resume an agent from its persisted log. */
  resume(sessionId: string): Promise<OwnedAgent>
}

/** Fetches a thread's history for seeding a brand-new session. */
export type ThreadSeeder = (threadId: string) => Promise<string>

/** How a delivery reached its session — the observable part of the branch taken. */
export type DeliveryBranch = 'live' | 'resumed' | 'created' | 'fallback'

/** One delivery outcome. */
export interface Delivery {
  sessionId: string
  branch: DeliveryBranch
  woken: boolean
}

interface Entry {
  owned: OwnedAgent
  lastUsed: number
}

/** An agent plus the branch that produced it. */
interface Acquired {
  agent: InjectableAgent
  branch: DeliveryBranch
}

/** Options for {@link ThreadSessionRouter}. */
export interface RouterOptions {
  config: Config
  sessions: SessionPort
  seedThread: ThreadSeeder
  /** Injected clock, so idle disposal is testable without waiting. */
  now?: () => number
  /** Non-fatal diagnostics. */
  onError?: (error: unknown, context: string) => void
}

/**
 * Owns the live thread-session population and the get-or-create path.
 */
export class ThreadSessionRouter {
  private readonly entries = new Map<string, Entry>()
  private readonly inFlight = new Map<string, Promise<Acquired | undefined>>()
  private readonly options: RouterOptions
  private readonly now: () => number
  private disposed = false

  constructor(options: RouterOptions) {
    this.options = options
    this.now = options.now ?? (() => Date.now())
  }

  /** Session id for a thread, honoring the single-session fallback mode. */
  sessionIdFor(threadId: string): string {
    const { threadSessions } = this.options.config
    return threadSessions.enabled
      ? sessionIdFor(threadSessions.sessionIdPrefix, threadId)
      : threadSessions.fallbackSessionId
  }

  /** Live session count, for tests and the flood cap. */
  get liveCount(): number {
    return this.entries.size
  }

  /**
   * Deliver text into the session bound to a thread.
   * @param threadId - the AgentMail thread.
   * @param text - model-facing content, already fenced by the caller.
   * @param wake - whether to start a turn rather than only appending context.
   * @returns the delivery outcome, or undefined when no session could be reached.
   */
  async deliver(threadId: string, text: string, wake: boolean): Promise<Delivery | undefined> {
    if (this.disposed) return undefined
    const sessionId = this.sessionIdFor(threadId)

    const acquired = await this.acquire(threadId, sessionId)
    if (acquired === undefined) return undefined

    try {
      if (wake) acquired.agent.followup(text)
      else acquired.agent.inject(text)
    } catch (error) {
      // The agent may have been disposed between acquisition and delivery.
      this.options.onError?.(error, `deliver to ${sessionId}`)
      this.entries.delete(sessionId)
      return undefined
    }

    return { sessionId, branch: acquired.branch, woken: wake }
  }

  /**
   * Get or create the agent for a session id.
   *
   * The in-flight latch is the whole reason this is not three lines: two
   * messages arriving on one thread inside the create window would otherwise
   * both miss `get()` and both create the same session. The branch travels with
   * the result rather than in shared state, so concurrent deliveries to
   * different threads cannot mislabel each other.
   */
  private async acquire(threadId: string, sessionId: string): Promise<Acquired | undefined> {
    const live = this.entries.get(sessionId)
    if (live !== undefined) {
      live.lastUsed = this.now()
      return { agent: live.owned.agent, branch: this.branchFor('live') }
    }

    const external = this.options.sessions.get(sessionId)
    if (external !== undefined) return { agent: external, branch: this.branchFor('live') }

    const pending = this.inFlight.get(sessionId)
    if (pending !== undefined) return pending

    const attempt = this.build(threadId, sessionId)
      .finally(() => { this.inFlight.delete(sessionId) })
    this.inFlight.set(sessionId, attempt)
    return attempt
  }

  /** Report `fallback` instead of the real branch in single-session mode. */
  private branchFor(branch: DeliveryBranch): DeliveryBranch {
    return this.options.config.threadSessions.enabled ? branch : 'fallback'
  }

  private async build(threadId: string, sessionId: string): Promise<Acquired | undefined> {
    try {
      if (await this.options.sessions.exists(sessionId)) {
        const owned = await this.options.sessions.resume(sessionId)
        this.track(sessionId, owned)
        return { agent: owned.agent, branch: this.branchFor('resumed') }
      }

      // Fresh: AgentMail rebuilds the conversation we never stored. Seeding
      // happens before the first turn, so the agent starts with full history.
      const seed = await this.options.seedThread(threadId)
      const owned = await this.options.sessions.create(sessionId)
      this.track(sessionId, owned)
      if (seed.length > 0) owned.agent.inject(seed)
      return { agent: owned.agent, branch: this.branchFor('created') }
    } catch (error) {
      this.options.onError?.(error, `acquire ${sessionId}`)
      return undefined
    }
  }

  private track(sessionId: string, owned: OwnedAgent): void {
    this.entries.set(sessionId, { owned, lastUsed: this.now() })
    void this.enforceFloodCap()
  }

  /**
   * Dispose sessions idle beyond the configured window.
   *
   * Eviction order does not matter: disposal drops only the in-memory agent,
   * and both the persisted log and AgentMail can rebuild it.
   * @returns the session ids disposed.
   */
  async disposeIdle(): Promise<string[]> {
    const cutoff = this.now() - this.options.config.threadSessions.idleDisposeMs
    const stale = [...this.entries.entries()].filter(([, entry]) => entry.lastUsed <= cutoff)
    return this.disposeAll(stale.map(([sessionId]) => sessionId))
  }

  private async enforceFloodCap(): Promise<void> {
    const { maxLive } = this.options.config.threadSessions
    if (this.entries.size <= maxLive) return
    const excess = [...this.entries.entries()]
      .sort((left, right) => left[1].lastUsed - right[1].lastUsed)
      .slice(0, this.entries.size - maxLive)
      .map(([sessionId]) => sessionId)
    await this.disposeAll(excess)
  }

  private async disposeAll(sessionIds: readonly string[]): Promise<string[]> {
    const disposed: string[] = []
    for (const sessionId of sessionIds) {
      const entry = this.entries.get(sessionId)
      if (entry === undefined) continue
      this.entries.delete(sessionId)
      try {
        await entry.owned.dispose()
        disposed.push(sessionId)
      } catch (error) {
        this.options.onError?.(error, `dispose ${sessionId}`)
      }
    }
    return disposed
  }

  /** Tear down every live session. */
  async dispose(): Promise<void> {
    this.disposed = true
    await this.disposeAll([...this.entries.keys()])
  }
}
