import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Config } from '../src/config.js'
import {
  ThreadSessionRouter, type InjectableAgent, type OwnedAgent, type SessionPort,
} from '../src/threads.js'

/**
 * Build a validated Config from a partial literal. The cast is needed because
 * the schema's constructor signature is the OUTPUT type, while the whole point
 * of passing a partial here is to exercise the schema's own defaulting.
 */
function config(overrides: Record<string, unknown> = {}): Config {
  return new Config({ apiKey: 'k', ...overrides } as unknown as Config)
}

/** A fake agent recording everything delivered to it. */
class FakeAgent implements InjectableAgent {
  injected: string[] = []
  followups: string[] = []
  inject(text: string): void {
    this.injected.push(text)
  }
  followup(text: string): void {
    this.followups.push(text)
  }
}

interface Recorder {
  port: SessionPort
  agents: Map<string, FakeAgent>
  created: string[]
  resumed: string[]
  disposed: string[]
  persisted: Set<string>
  live: Map<string, FakeAgent>
  createDelayMs: number
}

function recorder(options: { persisted?: string[], createDelayMs?: number } = {}): Recorder {
  const state: Recorder = {
    agents: new Map(),
    created: [],
    resumed: [],
    disposed: [],
    persisted: new Set(options.persisted ?? []),
    live: new Map(),
    createDelayMs: options.createDelayMs ?? 0,
    port: undefined as unknown as SessionPort,
  }

  const own = (sessionId: string): OwnedAgent => {
    const agent = new FakeAgent()
    state.agents.set(sessionId, agent)
    return {
      agent,
      dispose() {
        state.disposed.push(sessionId)
      },
    }
  }

  state.port = {
    get(sessionId) {
      return state.live.get(sessionId)
    },
    async exists(sessionId) {
      return state.persisted.has(sessionId)
    },
    async create(sessionId) {
      if (state.createDelayMs > 0) await new Promise(resolve => setTimeout(resolve, state.createDelayMs))
      state.created.push(sessionId)
      return own(sessionId)
    },
    async resume(sessionId) {
      state.resumed.push(sessionId)
      return own(sessionId)
    },
  }
  return state
}

describe('three-branch get-or-create', () => {
  it('creates and seeds a session for an unseen thread', async () => {
    const state = recorder()
    const router = new ThreadSessionRouter({
      config: config(),
      sessions: state.port,
      seedThread: async () => 'THREAD HISTORY',
    })

    const result = await router.deliver('thread_1', 'NEW MAIL', false)

    assert.equal(result?.branch, 'created')
    assert.equal(result?.sessionId, 'agentmail-thread_1')
    assert.deepEqual(state.created, ['agentmail-thread_1'])
    // History first, then the new message — the session rebuilds from AgentMail.
    assert.deepEqual(state.agents.get('agentmail-thread_1')?.injected, ['THREAD HISTORY', 'NEW MAIL'])
  })

  it('resumes a persisted session instead of rebuilding it', async () => {
    const state = recorder({ persisted: ['agentmail-thread_1'] })
    let seeded = false
    const router = new ThreadSessionRouter({
      config: config(),
      sessions: state.port,
      seedThread: async () => { seeded = true; return 'HISTORY' },
    })

    const result = await router.deliver('thread_1', 'NEW MAIL', false)

    assert.equal(result?.branch, 'resumed')
    assert.deepEqual(state.resumed, ['agentmail-thread_1'])
    assert.deepEqual(state.created, [])
    // Resuming preserves the reasoning trail, so no API reseed is needed.
    assert.equal(seeded, false)
  })

  it('reuses a live agent owned elsewhere', async () => {
    const state = recorder()
    const live = new FakeAgent()
    state.live.set('agentmail-thread_1', live)
    const router = new ThreadSessionRouter({
      config: config(),
      sessions: state.port,
      seedThread: async () => 'HISTORY',
    })

    const result = await router.deliver('thread_1', 'NEW MAIL', false)

    assert.equal(result?.branch, 'live')
    assert.deepEqual(live.injected, ['NEW MAIL'])
    assert.deepEqual(state.created, [])
  })

  it('skips an empty seed rather than injecting a useless preamble', async () => {
    // The AgentMail event can beat thread materialization, so threads.get may
    // briefly report no messages. The triggering message is in the notice
    // anyway, so an empty seed must contribute nothing.
    const state = recorder()
    const router = new ThreadSessionRouter({
      config: config(),
      sessions: state.port,
      seedThread: async () => '',
    })

    await router.deliver('thread_1', 'NEW MAIL', false)

    assert.deepEqual(state.agents.get('agentmail-thread_1')?.injected, ['NEW MAIL'])
  })

  it('wakes the agent only when configured to', async () => {
    const state = recorder()
    const router = new ThreadSessionRouter({
      config: config(),
      sessions: state.port,
      seedThread: async () => '',
    })

    await router.deliver('thread_1', 'QUIET', false)
    await router.deliver('thread_2', 'LOUD', true)

    assert.deepEqual(state.agents.get('agentmail-thread_1')?.followups, [])
    assert.deepEqual(state.agents.get('agentmail-thread_2')?.followups, ['LOUD'])
  })
})

describe('concurrency latch', () => {
  it('creates one session when two messages race on the same thread', async () => {
    const state = recorder({ createDelayMs: 20 })
    const router = new ThreadSessionRouter({
      config: config(),
      sessions: state.port,
      seedThread: async () => 'HISTORY',
    })

    // Both miss get() inside the create window. Without the latch this creates
    // the same session twice.
    const [first, second] = await Promise.all([
      router.deliver('thread_1', 'FIRST', false),
      router.deliver('thread_1', 'SECOND', false),
    ])

    assert.deepEqual(state.created, ['agentmail-thread_1'])
    assert.equal(first?.sessionId, second?.sessionId)
    assert.equal(router.liveCount, 1)
    const injected = state.agents.get('agentmail-thread_1')?.injected ?? []
    assert.ok(injected.includes('FIRST') && injected.includes('SECOND'))
  })

  it('keeps distinct threads independent', async () => {
    const state = recorder({ createDelayMs: 10 })
    const router = new ThreadSessionRouter({
      config: config(),
      sessions: state.port,
      seedThread: async () => '',
    })

    const results = await Promise.all([
      router.deliver('thread_a', 'A', false),
      router.deliver('thread_b', 'B', false),
    ])

    assert.equal(new Set(results.map(result => result?.sessionId)).size, 2)
    assert.equal(state.created.length, 2)
    // Branch travels with the result, so concurrent creates cannot mislabel.
    assert.deepEqual(results.map(result => result?.branch), ['created', 'created'])
  })
})

describe('disposal', () => {
  it('disposes idle sessions and rebuilds them on the next message', async () => {
    const state = recorder()
    let clock = 1_000
    const router = new ThreadSessionRouter({
      config: config({ threadSessions: { idleDisposeMs: 100 } }),
      sessions: state.port,
      seedThread: async () => 'HISTORY',
      now: () => clock,
    })

    await router.deliver('thread_1', 'FIRST', false)
    assert.equal(router.liveCount, 1)

    clock += 1_000
    assert.deepEqual(await router.disposeIdle(), ['agentmail-thread_1'])
    assert.equal(router.liveCount, 0)

    // Disposal is not deletion: the next message rebuilds from the API.
    await router.deliver('thread_1', 'SECOND', false)
    assert.equal(state.created.length, 2)
  })

  it('keeps sessions that are still active', async () => {
    const state = recorder()
    let clock = 1_000
    const router = new ThreadSessionRouter({
      config: config({ threadSessions: { idleDisposeMs: 10_000 } }),
      sessions: state.port,
      seedThread: async () => '',
      now: () => clock,
    })

    await router.deliver('thread_1', 'FIRST', false)
    clock += 100
    assert.deepEqual(await router.disposeIdle(), [])
    assert.equal(router.liveCount, 1)
  })

  it('enforces the flood cap', async () => {
    const state = recorder()
    let clock = 0
    const router = new ThreadSessionRouter({
      config: config({ threadSessions: { maxLive: 2 } }),
      sessions: state.port,
      seedThread: async () => '',
      now: () => { clock += 10; return clock },
    })

    for (const thread of ['t1', 't2', 't3', 't4']) {
      await router.deliver(thread, 'MAIL', false)
    }

    assert.equal(router.liveCount <= 2, true, `expected <= 2 live sessions, got ${router.liveCount}`)
    assert.equal(state.disposed.length >= 2, true)
  })
})

describe('single-session mode', () => {
  it('routes every thread into the fallback session', async () => {
    const state = recorder()
    const router = new ThreadSessionRouter({
      config: config({ threadSessions: { enabled: false, fallbackSessionId: 'mailbox' } }),
      sessions: state.port,
      seedThread: async () => '',
    })

    const first = await router.deliver('thread_a', 'A', false)
    const second = await router.deliver('thread_b', 'B', false)

    assert.equal(first?.sessionId, 'mailbox')
    assert.equal(second?.sessionId, 'mailbox')
    assert.equal(first?.branch, 'fallback')
    assert.deepEqual(state.created, ['mailbox'])
  })
})

describe('failure handling', () => {
  it('survives a create failure without throwing', async () => {
    const errors: string[] = []
    const failing: SessionPort = {
      get: () => undefined,
      exists: async () => false,
      create: async () => { throw new Error('AgentMail unreachable') },
      resume: async () => { throw new Error('unused') },
    }
    const router = new ThreadSessionRouter({
      config: config(),
      sessions: failing,
      seedThread: async () => 'HISTORY',
      onError: (_error, where) => { errors.push(where) },
    })

    assert.equal(await router.deliver('thread_1', 'MAIL', false), undefined)
    assert.deepEqual(errors, ['acquire agentmail-thread_1'])
  })

  it('retries after a transient failure rather than latching it forever', async () => {
    let attempts = 0
    const flaky: SessionPort = {
      get: () => undefined,
      exists: async () => false,
      async create() {
        attempts += 1
        if (attempts === 1) throw new Error('transient')
        return { agent: new FakeAgent(), dispose() {} }
      },
      resume: async () => { throw new Error('unused') },
    }
    const router = new ThreadSessionRouter({
      config: config(),
      sessions: flaky,
      seedThread: async () => '',
    })

    assert.equal(await router.deliver('thread_1', 'FIRST', false), undefined)
    assert.notEqual(await router.deliver('thread_1', 'SECOND', false), undefined)
    assert.equal(attempts, 2)
  })
})
