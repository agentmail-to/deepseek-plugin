/**
 * The inbound driver: real mail arriving turns into agent context.
 *
 * This is the capability the MCP path cannot offer, and the reason this plugin
 * exists as native code rather than a YAML snippet.
 * @module dsh-agentmail/inbound
 */
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  createRuntime, requestOptions, threadIdOf, toRenderable, type RawMessage, type Runtime,
} from './client.js'
import { Config } from './config.js'
import { sweepFollowups } from './followup.js'
import { EVENT_TYPE, FAILURE_EVENTS, FRAME } from './naming.js'
import { renderFailureNotice, renderInboundNotice, renderThread } from './render.js'
import { superviseSocket, type SupervisedSocket } from './socket.js'
import { ThreadSessionRouter, type InjectableAgent, type OwnedAgent, type SessionPort } from './threads.js'

export const name = 'agentmail-inbound'
export const inject = ['agents']
export { Config }

/**
 * Wire inbound mail into the agent registry.
 * @param ctx - plugin context.
 * @param config - validated configuration.
 */
export function apply(ctx: Context, config: Config): void {
  if (config.inbound.mode === 'off') return

  const runtime = createRuntime(config)
  const onError = (error: unknown, where: string): void => {
    ctx.logger?.warn?.(`[dsh-agentmail] ${where}: ${String(error)}`)
  }

  const router = new ThreadSessionRouter({
    config,
    sessions: sessionPort(ctx, config),
    seedThread: threadId => seedThread(runtime, threadId),
    onError,
  })
  ctx.effect(() => () => { void router.dispose() })

  const deliverMessage = async (raw: RawMessage): Promise<void> => {
    const threadId = raw.threadId ?? raw.thread_id
    if (threadId === undefined) return
    const message = toRenderable(raw)
    await router.deliver(
      threadId,
      renderInboundNotice(message, config.maxBodyChars),
      config.inbound.wakeIdleAgent,
    )
  }

  let lastSeen: Date | undefined

  /** Bounded set of processed message ids; backfill overlaps the live stream. */
  const processed = new Set<string>()
  const alreadyProcessed = (messageId: string | undefined): boolean => {
    if (messageId === undefined) return false
    if (processed.has(messageId)) return true
    processed.add(messageId)
    // Cheap FIFO trim: identity matters only across a reconnect window.
    if (processed.size > 500) processed.delete(processed.values().next().value as string)
    return false
  }

  const handleEvent = (payload: unknown): void => {
    if (typeof payload !== 'object' || payload === null) return
    const event = payload as { type?: string; eventType?: string; message?: RawMessage }
    if (event.type === FRAME.subscribed) return

    // The discriminant is `eventType`, not `type` — `type` is always 'event'.
    const kind = event.eventType
    if (kind === undefined) return

    if (kind === EVENT_TYPE.messageReceived) {
      const raw = event.message
      if (raw === undefined) return
      if (alreadyProcessed(raw.messageId ?? raw.message_id)) return
      lastSeen = toDate(raw.timestamp) ?? lastSeen
      void deliverMessage(raw).catch(error => { onError(error, 'deliver inbound') })
      return
    }

    if (FAILURE_EVENTS.includes(kind)) {
      // A bounce means an earlier send did NOT arrive. Telling the thread's own
      // session is the whole value: otherwise the agent assumes success.
      const threadId = threadIdOf(event)
      if (threadId === undefined) return
      const notice = renderFailureNotice(kind, event.message ? toRenderable(event.message) : undefined)
      void router.deliver(threadId, notice, false).catch(error => { onError(error, 'deliver failure') })
    }
  }

  const backfill = async (): Promise<void> => {
    if (lastSeen === undefined) return
    try {
      const inboxId = await runtime.inboxId()
      const response = await runtime.client.inboxes.messages.list(inboxId, {
        limit: 50,
        after: lastSeen,
      }, requestOptions(config))
      for (const message of response.messages ?? []) {
        await deliverMessage(message as RawMessage)
      }
    } catch (error) {
      onError(error, 'backfill')
    }
  }

  if (config.inbound.mode === 'websocket') {
    startSocket(ctx, runtime, config, handleEvent, backfill, onError)
  } else {
    startPolling(ctx, runtime, config, deliverMessage, onError)
  }

  startIdleSweep(ctx, config, router, onError)
  startFollowupSweep(ctx, runtime, config, router, onError)
}

/**
 * Run `fn` on an interval for the plugin's lifetime.
 *
 * Cordis Context exposes no timer API; `ctx.effect` with an explicit disposer
 * is the documented pattern, and it unregisters on unload and HMR for free.
 */
function every(ctx: Context, ms: number, fn: () => void): void {
  ctx.effect(() => {
    const timer = setInterval(fn, ms)
    return () => { clearInterval(timer) }
  })
}

/** A session-persistence backend, reduced to the one call this plugin makes. */
interface PersistenceLike {
  list(): Promise<{ id: string }[]>
}

/**
 * Resolve an OPTIONAL service without stalling the plugin that wants it.
 *
 * Cordis has no optional `inject`: every declared dependency is awaited, and
 * reading an undeclared `ctx.<service>` throws rather than yielding undefined.
 * `ctx.inject()` starts a nested fiber that runs only once the service exists,
 * so the reference stays undefined forever in a composition without it.
 * @param ctx - plugin context.
 * @returns a holder whose `current` is set once the service is available.
 */
function optionalPersistence(ctx: Context): { current: PersistenceLike | undefined } {
  const ref: { current: PersistenceLike | undefined } = { current: undefined }
  ctx.inject(['sessionPersistence'], scoped => {
    ref.current = (scoped as unknown as { sessionPersistence: PersistenceLike }).sessionPersistence
  })
  return ref
}

/** Adapt `ctx.agents` (plus optional persistence) to the router's narrow port. */
function sessionPort(ctx: Context, config: Config): SessionPort {
  const persistenceRef = optionalPersistence(ctx)
  const wrap = (agent: {
    inject(message: ReturnType<typeof createUserMessage>): void
    followup(message: ReturnType<typeof createUserMessage>): void
  }): InjectableAgent => ({
    inject(text) {
      agent.inject(message(text))
    },
    followup(text) {
      agent.followup(message(text))
    },
  })

  const message = (text: string): ReturnType<typeof createUserMessage> => createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'dsh-agentmail' },
  })

  return {
    get(sessionId) {
      const agent = ctx.agents.get(SessionId(sessionId))
      return agent === undefined ? undefined : wrap(agent)
    },
    async exists(sessionId) {
      // `resume()` rejects for a missing session the same way it rejects for a
      // real I/O error, and conflating those would silently start a blank
      // session and lose the thread's history — so probe first.
      //
      // `sessionPersistence` stays out of this plugin's top-level `inject`:
      // requiring it would stall inbound mail entirely where persistence is not
      // configured. It cannot simply be read off `ctx` either — Cordis throws
      // "cannot get property X without inject" rather than returning undefined —
      // so {@link persistenceRef} resolves it through a nested fiber that only
      // runs if the service exists. Absent, every thread rebuilds from the API:
      // that costs the reasoning trail, never correctness.
      const persistence = persistenceRef.current
      if (persistence === undefined) return false
      try {
        const headers = await persistence.list()
        return headers.some(header => header.id === sessionId)
      } catch {
        return false
      }
    },
    async create(sessionId) {
      const handle = await ctx.agents.create({
        sessionId: SessionId(sessionId),
        meta: { cwd: config.threadSessions.cwd ?? process.cwd() },
      })
      return toOwned(handle, wrap)
    },
    async resume(sessionId) {
      const handle = await ctx.agents.resume({ resumeSessionId: SessionId(sessionId) })
      return toOwned(handle, wrap)
    },
  }
}

function toOwned(
  handle: { agent: unknown, dispose(): Promise<void> | void },
  wrap: (agent: never) => InjectableAgent,
): OwnedAgent {
  return {
    agent: wrap(handle.agent as never),
    dispose: () => handle.dispose(),
  }
}

/** Open and supervise the WebSocket. */
function startSocket(
  ctx: Context,
  runtime: Runtime,
  config: Config,
  onMessage: (payload: unknown) => void,
  backfill: () => Promise<void>,
  onError: (error: unknown, where: string) => void,
): void {
  ctx.effect(() => {
    const supervisor = superviseSocket({
      async connect() {
        const socket = await runtime.client.websockets.connect({
          reconnectAttempts: config.inbound.reconnectAttempts,
          connectionTimeoutInSeconds: config.inbound.connectionTimeoutSeconds,
        })
        return socket as unknown as SupervisedSocket
      },
      onOpen(socket) {
        void runtime.inboxId().then(inboxId => {
          // sendSubscribe throws unless the socket is OPEN, and 'open' fires
          // again after every SDK-internal reconnect — so subscription and
          // backfill both belong here.
          ;(socket as unknown as {
            sendSubscribe(message: { type: 'subscribe', inboxIds: string[], eventTypes: string[] }): void
          }).sendSubscribe({
            type: 'subscribe',
            inboxIds: [inboxId],
            eventTypes: config.inbound.eventTypes,
          })
          void backfill()
        }).catch(error => { onError(error, 'subscribe') })
      },
      onMessage,
      onError,
      onReplace: reason => { onError(new Error(reason), 'replacing socket') },
    })
    return () => { supervisor.stop() }
  })
}

/** Poll for new mail where a WebSocket is unavailable. */
function startPolling(
  ctx: Context,
  runtime: Runtime,
  config: Config,
  deliver: (raw: RawMessage) => Promise<void>,
  onError: (error: unknown, where: string) => void,
): void {
  let after: Date | undefined
  every(ctx, config.inbound.pollIntervalMs, () => {
    void (async () => {
      try {
        const inboxId = await runtime.inboxId()
        const response = await runtime.client.inboxes.messages.list(inboxId, {
          limit: 50,
          ...(after === undefined ? {} : { after }),
        }, requestOptions(config))
        for (const message of response.messages ?? []) {
          const raw = message as RawMessage
          const at = toDate(raw.timestamp)
          if (at !== undefined && (after === undefined || at > after)) after = at
          await deliver(raw)
        }
      } catch (error) {
        onError(error, 'poll')
      }
    })()
  })
}

/** Dispose thread sessions that have gone idle. */
function startIdleSweep(
  ctx: Context,
  config: Config,
  router: ThreadSessionRouter,
  onError: (error: unknown, where: string) => void,
): void {
  const interval = Math.max(60_000, Math.floor(config.threadSessions.idleDisposeMs / 2))
  every(ctx, interval, () => {
    void router.disposeIdle().catch(error => { onError(error, 'idle sweep') })
  })
}

/** Revive threads whose follow-up label has come due. */
function startFollowupSweep(
  ctx: Context,
  runtime: Runtime,
  config: Config,
  router: ThreadSessionRouter,
  onError: (error: unknown, where: string) => void,
): void {
  if (config.readOnly) return
  every(ctx, config.threadSessions.followupSweepMs, () => {
    void sweepFollowups({ runtime, router, onError })
  })
}

/** Coerce a wire timestamp to a Date, tolerating both string and Date forms. */
function toDate(value: string | Date | undefined): Date | undefined {
  if (value === undefined) return undefined
  const date = typeof value === 'string' ? new Date(value) : value
  return Number.isNaN(date.getTime()) ? undefined : date
}

/** Fetch a whole thread as seed text for a brand-new session. */
async function seedThread(runtime: Runtime, threadId: string): Promise<string> {
  const inboxId = await runtime.inboxId()
  const thread = await runtime.client.inboxes.threads.get(
    inboxId, threadId, requestOptions(runtime.config),
  )
  const messages = (thread.messages ?? []).map(message => toRenderable(message as RawMessage))
  if (messages.length === 0) return ''
  return [
    'You are now handling one email thread. Its history follows.',
    renderThread(thread.subject, threadId, messages, runtime.config.maxBodyChars),
  ].join('\n\n')
}
