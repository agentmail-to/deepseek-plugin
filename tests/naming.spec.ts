import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  bareAddress, dueFollowupLabels, EVENT_TYPE, FAILURE_EVENTS, followupDueDate, followupLabel,
  FRAME, recipientAllowed, recipientsOf, sessionIdFor, threadIdFrom,
} from '../src/naming.js'

describe('session id binding', () => {
  it('round-trips a thread id', () => {
    const id = sessionIdFor('agentmail-', 'thread_456def')
    assert.equal(id, 'agentmail-thread_456def')
    assert.equal(threadIdFrom('agentmail-', id), 'thread_456def')
  })

  it('rejects a session that is not thread-bound', () => {
    assert.equal(threadIdFrom('agentmail-', 'client-session'), undefined)
    assert.equal(threadIdFrom('agentmail-', 'agentmail-'), undefined)
  })

  it('keeps the default prefix inside the filesystem-safe charset', () => {
    // encodeSegment keeps only [A-Za-z0-9._-] literal; ':' would become ~003A
    // and make on-disk session directories unreadable.
    assert.match(sessionIdFor('agentmail-', 'thread_456def'), /^[A-Za-z0-9._-]+$/)
  })
})

describe('wire event names', () => {
  it('uses the dotted spelling verified against the live API', () => {
    // The SDK's TS union claims `type: 'message_received'`, but it parses with
    // skipValidation and the server actually sends
    // `{ type: 'event', eventType: 'message.received' }`. Confirmed live.
    assert.equal(EVENT_TYPE.messageReceived, 'message.received')
    assert.equal(FRAME.event, 'event')
    assert.equal(FRAME.subscribed, 'subscribed')
  })

  it('uses one spelling for both the subscribe filter and the discriminant', () => {
    // The subscribe filter and envelope eventType are the same string, so there
    // is no second spelling to get wrong.
    assert.equal(EVENT_TYPE.messageReceived, 'message.received')
  })

  it('treats bounce-family events as failures', () => {
    assert.ok(FAILURE_EVENTS.includes('message.bounced'))
    assert.ok(FAILURE_EVENTS.includes('message.rejected'))
    assert.equal(FAILURE_EVENTS.includes('message.received'), false)
  })
})

describe('follow-up labels', () => {
  it('round-trips a due date', () => {
    assert.equal(followupLabel('2026-08-20'), 'dsh-followup-2026-08-20')
    assert.equal(followupDueDate('dsh-followup-2026-08-20'), '2026-08-20')
  })

  it('ignores unrelated and malformed labels', () => {
    assert.equal(followupDueDate('important'), undefined)
    assert.equal(followupDueDate('dsh-followup-soon'), undefined)
  })

  it('selects only labels due on or before today', () => {
    const labels = ['dsh-followup-2026-08-16', 'dsh-followup-2026-08-17', 'dsh-followup-2026-12-01', 'urgent']
    assert.deepEqual(dueFollowupLabels(labels, '2026-08-17'), [
      'dsh-followup-2026-08-16',
      'dsh-followup-2026-08-17',
    ])
  })
})

describe('recipient allowlist', () => {
  it('permits everything when unset', () => {
    assert.equal(recipientAllowed('anyone@example.com', []), true)
  })

  it('matches exact addresses and domain suffixes', () => {
    assert.equal(recipientAllowed('a@acme.com', ['@acme.com']), true)
    assert.equal(recipientAllowed('a@evil.com', ['@acme.com']), false)
    assert.equal(recipientAllowed('exact@x.com', ['exact@x.com']), true)
    assert.equal(recipientAllowed('other@x.com', ['exact@x.com']), false)
  })

  it('is case-insensitive and sees through display names', () => {
    assert.equal(recipientAllowed('Alice <ALICE@Acme.com>', ['@acme.com']), true)
    assert.equal(bareAddress('Alice <alice@acme.com>'), 'alice@acme.com')
  })

  it('does not let a display name smuggle an allowed domain past the check', () => {
    // The angle-bracket address is authoritative; the label is decoration.
    assert.equal(recipientAllowed('"ok@acme.com" <attacker@evil.com>', ['@acme.com']), false)
  })

  it('collects recipients from to, cc, and bcc', () => {
    assert.deepEqual(
      recipientsOf({ to: ['a@x.com'], cc: ['b@x.com'], bcc: ['c@x.com'], subject: 'hi' }),
      ['a@x.com', 'b@x.com', 'c@x.com'],
    )
  })

  it('tolerates malformed model arguments', () => {
    assert.deepEqual(recipientsOf(undefined), [])
    assert.deepEqual(recipientsOf('nonsense'), [])
    assert.deepEqual(recipientsOf({ to: [1, 'a@x.com', null] }), ['a@x.com'])
  })
})
