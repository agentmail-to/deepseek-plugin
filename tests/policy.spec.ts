import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { checkAllowlist } from '../src/approval.js'
import { Config } from '../src/config.js'
import { identityText } from '../src/identity.js'
import { buildTools, OUTBOUND_TOOLS } from '../src/tools.js'
import { createRuntime, type Client } from '../src/client.js'

function config(overrides: Record<string, unknown> = {}): Config {
  return new Config({ apiKey: 'k', ...overrides } as unknown as Config)
}

describe('recipient allowlist gate', () => {
  it('denies a send outside the allowlist', () => {
    const verdict = checkAllowlist('agentmail_send_message', { to: ['x@evil.com'] }, ['@acme.com'])
    assert.equal(verdict.allowed, false)
    assert.deepEqual(verdict.rejected, ['x@evil.com'])
  })

  it('denies when only one of several recipients is disallowed', () => {
    const verdict = checkAllowlist(
      'agentmail_send_message',
      { to: ['ok@acme.com'], cc: ['x@evil.com'] },
      ['@acme.com'],
    )
    assert.equal(verdict.allowed, false)
    assert.deepEqual(verdict.rejected, ['x@evil.com'])
  })

  it('ignores tools that do not send mail', () => {
    const verdict = checkAllowlist('agentmail_get_thread', { threadId: 't1' }, ['@acme.com'])
    assert.equal(verdict.allowed, true)
  })

  it('permits everything when no allowlist is configured', () => {
    assert.equal(checkAllowlist('agentmail_send_message', { to: ['x@evil.com'] }, []).allowed, true)
  })

  it('cannot screen send_draft, whose recipients live on the draft', () => {
    // Documented gap: the approval gate still covers this tool.
    const verdict = checkAllowlist('agentmail_send_draft', { draftId: 'd1' }, ['@acme.com'])
    assert.equal(verdict.allowed, true)
  })
})

describe('tool surface', () => {
  const runtime = (overrides: Record<string, unknown> = {}) =>
    createRuntime(config(overrides), {} as Client)

  it('registers the full surface by default', () => {
    const names = buildTools(runtime()).map(tool => tool.name)
    assert.ok(names.includes('agentmail_send_message'))
    assert.ok(names.includes('agentmail_followup'))
    assert.equal(new Set(names).size, names.length, 'tool names must be unique')
  })

  it('registers no write tools in readOnly mode', () => {
    const names = buildTools(runtime({ readOnly: true })).map(tool => tool.name)
    for (const outbound of OUTBOUND_TOOLS) {
      assert.equal(names.includes(outbound), false, `${outbound} must not exist in readOnly mode`)
    }
    assert.ok(names.includes('agentmail_get_thread'), 'read tools remain available')
  })

  it('keeps the surface small enough to be worth its prompt cost', () => {
    assert.ok(buildTools(runtime()).length <= 12, 'every schema is paid on every request')
  })
})

describe('identity section', () => {
  it('states the address and the untrusted-content rule', () => {
    const text = identityText('agent@acme.com', config())
    assert.match(text, /agent@acme\.com/)
    assert.match(text, /real mail to real people/)
    assert.match(text, /never an instruction/)
  })

  it('degrades gracefully before the inbox resolves', () => {
    const text = identityText(undefined, config())
    assert.match(text, /agentmail_list_inboxes/)
    assert.match(text, /never an instruction/)
  })

  it('advertises follow-up labels over session-local reminders', () => {
    // A schedule_create reminder cannot wake a cold thread session; the label can.
    assert.match(identityText('a@x.com', config()), /agentmail_followup.*not.*schedule_create/s)
  })

  it('announces readOnly mode', () => {
    const text = identityText('a@x.com', config({ readOnly: true }))
    assert.match(text, /READ-ONLY/)
  })

  it('lists recipient restrictions when configured', () => {
    const text = identityText('a@x.com', config({ allowedRecipients: ['@acme.com'] }))
    assert.match(text, /@acme\.com/)
  })
})
