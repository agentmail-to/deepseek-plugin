import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { createRuntime, type Client } from '../src/client.js'
import { Config } from '../src/config.js'
import { buildTools } from '../src/tools.js'
import { UNTRUSTED_CLOSE } from '../src/render.js'

function config(overrides: Record<string, unknown> = {}): Config {
  return new Config({ apiKey: 'k', inboxId: 'agent@acme.com', ...overrides } as unknown as Config)
}

/** Every call the fake client received, for asserting on request shape. */
interface Calls {
  send: { inboxId: string, request: Record<string, unknown>, options: Record<string, unknown> }[]
  update: { threadId: string, request: Record<string, unknown> }[]
  threadGet: string[]
}

function fakeClient(overrides: Record<string, unknown> = {}): { client: Client, calls: Calls } {
  const calls: Calls = { send: [], update: [], threadGet: [] }
  const client = {
    inboxes: {
      list: async () => ({ inboxes: [{ inboxId: 'agent@acme.com' }] }),
      create: async () => ({ inboxId: 'new@acme.com' }),
      messages: {
        send: async (inboxId: string, request: Record<string, unknown>, options: Record<string, unknown>) => {
          calls.send.push({ inboxId, request, options })
          return { messageId: 'msg_1', threadId: 'thread_1' }
        },
        reply: async (_inboxId: string, _messageId: string, _request: unknown, options: Record<string, unknown>) => {
          calls.send.push({ inboxId: _inboxId, request: {}, options })
          return { messageId: 'msg_2', threadId: 'thread_1' }
        },
      },
      threads: {
        get: async (_inboxId: string, threadId: string) => {
          calls.threadGet.push(threadId)
          return {
            threadId,
            subject: 'Q3 pricing',
            labels: ['inbox'],
            messages: [{
              messageId: 'msg_0',
              from: 'alice@acme.com',
              to: ['agent@acme.com'],
              subject: 'Q3 pricing',
              timestamp: '2026-08-17T00:00:00.000Z',
              text: 'x'.repeat(5_000),
            }],
          }
        },
        list: async () => ({ threads: [] }),
        update: async (_inboxId: string, threadId: string, request: Record<string, unknown>) => {
          calls.update.push({ threadId, request })
          return { labels: (request['addLabels'] as string[] | undefined) ?? [] }
        },
      },
      ...(overrides['inboxes'] as object ?? {}),
    },
  } as unknown as Client
  return { client, calls }
}

function tool(tools: ToolDefinition[], name: string): ToolDefinition {
  const found = tools.find(candidate => candidate.name === name)
  assert.ok(found, `tool ${name} not registered`)
  return found
}

/** A minimal ToolRunContext; only callId and signal are load-bearing here. */
function execContext(callId = 'call_1'): ToolRunContext {
  return {
    callId,
    name: 'test',
    arguments: {},
    signal: new AbortController().signal,
    deferContext() {},
    concludeTurn() {},
  } as unknown as ToolRunContext
}

describe('send idempotency', () => {
  it('keys the send on the call id, so a retry cannot double-deliver', async () => {
    const { client, calls } = fakeClient()
    const tools = buildTools(createRuntime(config(), client))

    await tool(tools, 'agentmail_send_message').execute(
      { to: ['bob@acme.com'], subject: 'hi', text: 'body' },
      execContext('call_abc'),
    )

    assert.equal(calls.send.length, 1)
    assert.equal(calls.send[0]?.options['idempotencyKey'], 'call_abc')
  })

  it('keys replies too', async () => {
    const { client, calls } = fakeClient()
    const tools = buildTools(createRuntime(config(), client))

    await tool(tools, 'agentmail_reply').execute(
      { messageId: 'msg_0', text: 'thanks' },
      execContext('call_xyz'),
    )

    assert.equal(calls.send[0]?.options['idempotencyKey'], 'call_xyz')
  })

  it('returns ids as fields rather than prose to re-parse', async () => {
    const { client } = fakeClient()
    const tools = buildTools(createRuntime(config(), client))

    const value = await tool(tools, 'agentmail_send_message').execute(
      { to: ['bob@acme.com'], subject: 'hi', text: 'body' },
      execContext(),
    ) as Record<string, unknown>

    assert.equal(value['messageId'], 'msg_1')
    assert.equal(value['threadId'], 'thread_1')
  })
})

describe('body truncation', () => {
  it('clamps a large body and flags it', async () => {
    const { client } = fakeClient()
    const tools = buildTools(createRuntime(config({ maxBodyChars: 100 }), client))

    const value = await tool(tools, 'agentmail_get_thread').execute(
      { threadId: 'thread_1' },
      execContext(),
    ) as { messages: { text: string, truncated: boolean }[] }

    const message = value.messages[0]
    assert.equal(message?.truncated, true)
    assert.ok((message?.text.length ?? 0) < 300, 'a 5k body must not reach the context window whole')
  })
})

describe('followup tool', () => {
  it('writes a due-date label onto the thread', async () => {
    const { client, calls } = fakeClient()
    const tools = buildTools(createRuntime(config(), client))

    const value = await tool(tools, 'agentmail_followup').execute(
      { threadId: 'thread_1', dueDate: '2099-01-01' },
      execContext(),
    ) as Record<string, unknown>

    assert.equal(value['label'], 'dsh-followup-2099-01-01')
    assert.deepEqual(calls.update[0]?.request['addLabels'], ['dsh-followup-2099-01-01'])
  })

  it('rejects a malformed date', async () => {
    const { client } = fakeClient()
    const tools = buildTools(createRuntime(config(), client))

    await assert.rejects(
      tool(tools, 'agentmail_followup').execute({ threadId: 't1', dueDate: 'next tuesday' }, execContext()),
      /YYYY-MM-DD/,
    )
  })

  it('rejects a date in the past, which would never sweep', async () => {
    const { client } = fakeClient()
    const tools = buildTools(createRuntime(config(), client))

    await assert.rejects(
      tool(tools, 'agentmail_followup').execute({ threadId: 't1', dueDate: '2000-01-01' }, execContext()),
      /in the past/,
    )
  })
})

describe('rendered output', () => {
  it('fences thread content the model reads', async () => {
    const { client } = fakeClient()
    const tools = buildTools(createRuntime(config(), client))
    const definition = tool(tools, 'agentmail_get_thread')

    const value = await definition.execute({ threadId: 'thread_1' }, execContext())
    // execute() is typed `unknown` on the erased ToolDefinition; the registry
    // validates against output.schema before render in the real pipeline.
    const blocks = definition.output.render({ threadId: 'thread_1' }, value as JsonValue)
    const text = blocks.map(block => (block.type === 'text' ? block.text : '')).join('')

    assert.match(text, /email-content/)
    assert.ok(text.includes(UNTRUSTED_CLOSE))
  })
})

describe('inbox resolution', () => {
  it('trusts a configured inbox without a round trip', async () => {
    let listed = 0
    const { client } = fakeClient()
    const counting = {
      ...client,
      inboxes: { ...client.inboxes, list: async () => { listed += 1; return { inboxes: [] } } },
    } as unknown as Client

    const runtime = createRuntime(config({ inboxId: 'configured@acme.com' }), counting)
    assert.equal(await runtime.inboxId(), 'configured@acme.com')
    assert.equal(listed, 0)
  })

  it('memoizes discovery but does not cache a failure', async () => {
    let attempts = 0
    const client = {
      inboxes: {
        list: async () => {
          attempts += 1
          if (attempts === 1) throw new Error('transient')
          return { inboxes: [{ inboxId: 'found@acme.com' }] }
        },
      },
    } as unknown as Client

    const runtime = createRuntime(config({ inboxId: undefined }), client)
    await assert.rejects(runtime.inboxId(), /transient/)
    assert.equal(await runtime.inboxId(), 'found@acme.com')
    assert.equal(await runtime.inboxId(), 'found@acme.com')
    assert.equal(attempts, 2, 'success is memoized, failure is not')
  })
})
