import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createRuntime, type Client } from '../src/client.js'
import { Config } from '../src/config.js'
import { findDueFollowups, sweepFollowups } from '../src/followup.js'
import { ThreadSessionRouter, type InjectableAgent, type SessionPort } from '../src/threads.js'

function config(overrides: Record<string, unknown> = {}): Config {
  return new Config({ apiKey: 'k', inboxId: 'agent@acme.com', ...overrides } as unknown as Config)
}

interface Fake {
  client: Client
  removed: { threadId: string, labels: string[] }[]
}

function fakeClient(threads: { threadId: string, labels: string[] }[]): Fake {
  const removed: Fake['removed'] = []
  const client = {
    inboxes: {
      list: async () => ({ inboxes: [{ inboxId: 'agent@acme.com' }] }),
      threads: {
        list: async () => ({ threads }),
        update: async (_inboxId: string, threadId: string, request: { removeLabels?: string[] }) => {
          removed.push({ threadId, labels: request.removeLabels ?? [] })
          return { labels: [] }
        },
      },
    },
  } as unknown as Client
  return { client, removed }
}

/** A router whose deliveries are recorded rather than performed. */
function fakeRouter(config_: Config, onDeliver: (threadId: string, text: string, wake: boolean) => boolean) {
  const port: SessionPort = {
    get: () => undefined,
    exists: async () => false,
    create: async () => ({
      agent: { inject() {}, followup() {} } satisfies InjectableAgent,
      dispose() {},
    }),
    resume: async () => { throw new Error('unused') },
  }
  const router = new ThreadSessionRouter({ config: config_, sessions: port, seedThread: async () => '' })
  const delivered: { threadId: string, wake: boolean }[] = []
  router.deliver = async (threadId, text, wake) => {
    delivered.push({ threadId, wake })
    return onDeliver(threadId, text, wake)
      ? { sessionId: `agentmail-${threadId}`, branch: 'created', woken: wake }
      : undefined
  }
  return { router, delivered }
}

describe('findDueFollowups', () => {
  it('selects only threads whose label has come due', async () => {
    const { client } = fakeClient([
      { threadId: 't_due', labels: ['dsh-followup-2026-08-16'] },
      { threadId: 't_today', labels: ['dsh-followup-2026-08-17'] },
      { threadId: 't_future', labels: ['dsh-followup-2026-12-01'] },
      { threadId: 't_none', labels: ['inbox'] },
    ])
    const runtime = createRuntime(config(), client)

    const due = await findDueFollowups(runtime, '2026-08-17')

    assert.deepEqual(due.map(entry => entry.threadId), ['t_due', 't_today'])
    assert.equal(due[0]?.dueDate, '2026-08-16')
  })
})

describe('sweepFollowups', () => {
  it('wakes the thread session and clears the label', async () => {
    const cfg = config()
    const { client, removed } = fakeClient([
      { threadId: 't_due', labels: ['dsh-followup-2026-08-16'] },
    ])
    const { router, delivered } = fakeRouter(cfg, () => true)

    const swept = await sweepFollowups({
      runtime: createRuntime(cfg, client),
      router,
      today: () => '2026-08-17',
    })

    assert.deepEqual(swept, ['t_due'])
    // Waking is the point here: no mail is arriving to start this turn.
    assert.deepEqual(delivered, [{ threadId: 't_due', wake: true }])
    assert.deepEqual(removed, [{ threadId: 't_due', labels: ['dsh-followup-2026-08-16'] }])
  })

  it('keeps the label when delivery fails, so the sweep retries', async () => {
    const cfg = config()
    const { client, removed } = fakeClient([
      { threadId: 't_due', labels: ['dsh-followup-2026-08-16'] },
    ])
    const { router } = fakeRouter(cfg, () => false)

    const swept = await sweepFollowups({
      runtime: createRuntime(cfg, client),
      router,
      today: () => '2026-08-17',
    })

    assert.deepEqual(swept, [])
    assert.deepEqual(removed, [], 'a dropped follow-up would be lost forever')
  })

  it('reports a listing failure without throwing', async () => {
    const cfg = config()
    const client = {
      inboxes: {
        list: async () => ({ inboxes: [{ inboxId: 'agent@acme.com' }] }),
        threads: { list: async () => { throw new Error('AgentMail down') } },
      },
    } as unknown as Client
    const { router } = fakeRouter(cfg, () => true)
    const errors: string[] = []

    const swept = await sweepFollowups({
      runtime: createRuntime(cfg, client),
      router,
      today: () => '2026-08-17',
      onError: (_error, where) => { errors.push(where) },
    })

    assert.deepEqual(swept, [])
    assert.deepEqual(errors, ['followup sweep'])
  })
})
