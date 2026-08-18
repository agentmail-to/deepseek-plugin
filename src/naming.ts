/**
 * Pure name and label conventions. AgentMail is the source of truth, so every
 * mapping here is a total function over strings — there is no lookup table.
 * @module dsh-agentmail/naming
 */

/**
 * Frame kinds seen on the socket's `type` field.
 *
 * VERIFIED AGAINST THE LIVE API. The SDK's TypeScript union suggests
 * `type: 'message_received'`, but it parses with `skipValidation: true` and
 * passes the raw payload through, so those types describe a shape the server
 * does not send. Every real notification arrives as `type: 'event'` with the
 * actual name in {@link EVENT_TYPE}.
 */
export const FRAME = {
  subscribed: 'subscribed',
  event: 'event',
} as const

/**
 * Event names. The SAME dotted spelling is used by the subscribe filter and by
 * the envelope's `eventType` field, so there is exactly one spelling to know.
 */
export const EVENT_TYPE = {
  messageReceived: 'message.received',
  messageSent: 'message.sent',
  messageDelivered: 'message.delivered',
  messageBounced: 'message.bounced',
  messageComplained: 'message.complained',
  messageRejected: 'message.rejected',
} as const

/** Delivery-failure events worth telling the agent about. */
export const FAILURE_EVENTS: readonly string[] = [
  EVENT_TYPE.messageBounced,
  EVENT_TYPE.messageComplained,
  EVENT_TYPE.messageRejected,
]

/** Label prefix carrying a pending follow-up's due date. */
export const FOLLOWUP_LABEL_PREFIX = 'dsh-followup-'

/**
 * Session id for one thread. Total and reversible: the only durable link
 * between a harness session and an email thread is this string function.
 * @param prefix - configured session id prefix.
 * @param threadId - AgentMail thread id.
 * @returns the session id string (brand applied by the caller).
 */
export function sessionIdFor(prefix: string, threadId: string): string {
  return `${prefix}${threadId}`
}

/**
 * Recover a thread id from a session id.
 * @param prefix - configured session id prefix.
 * @param sessionId - candidate session id.
 * @returns the thread id, or undefined when the session is not thread-bound.
 */
export function threadIdFrom(prefix: string, sessionId: string): string | undefined {
  if (!sessionId.startsWith(prefix)) return undefined
  const rest = sessionId.slice(prefix.length)
  return rest.length > 0 ? rest : undefined
}

/**
 * Build the due-date label for a follow-up.
 * @param dueDate - ISO `YYYY-MM-DD` date.
 * @returns the label value.
 */
export function followupLabel(dueDate: string): string {
  return `${FOLLOWUP_LABEL_PREFIX}${dueDate}`
}

/**
 * Read a follow-up due date off a label.
 * @param label - candidate label.
 * @returns the ISO date, or undefined when the label is unrelated.
 */
export function followupDueDate(label: string): string | undefined {
  if (!label.startsWith(FOLLOWUP_LABEL_PREFIX)) return undefined
  const date = label.slice(FOLLOWUP_LABEL_PREFIX.length)
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined
}

/**
 * Select the follow-up labels that are due.
 * @param labels - every label on a thread.
 * @param today - ISO `YYYY-MM-DD` comparison date.
 * @returns due labels, lexicographic date order being chronological order.
 */
export function dueFollowupLabels(labels: readonly string[], today: string): string[] {
  return labels.filter(label => {
    const due = followupDueDate(label)
    return due !== undefined && due <= today
  })
}

/**
 * Match one recipient against an allowlist of addresses and `@domain` suffixes.
 * Comparison is case-insensitive; an empty allowlist permits everything.
 * @param recipient - a bare address or a `Display Name <addr>` form.
 * @param allowlist - configured entries.
 * @returns whether the recipient is permitted.
 */
export function recipientAllowed(recipient: string, allowlist: readonly string[]): boolean {
  if (allowlist.length === 0) return true
  const address = bareAddress(recipient).toLowerCase()
  if (address.length === 0) return false
  return allowlist.some(entry => {
    const rule = entry.trim().toLowerCase()
    if (rule.length === 0) return false
    if (rule.startsWith('@')) return address.endsWith(rule)
    return address === rule
  })
}

/**
 * Strip a display name from an address.
 * @param recipient - `addr` or `Display Name <addr>`.
 * @returns the bare address.
 */
export function bareAddress(recipient: string): string {
  const angled = /<([^>]*)>/.exec(recipient)
  return (angled?.[1] ?? recipient).trim()
}

/**
 * Collect every recipient address from a send/reply argument object.
 * Tolerates `unknown` because it also runs over model-supplied arguments in the
 * pre-execute gate, before any tool-level validation.
 * @param args - candidate arguments.
 * @returns every address found across to/cc/bcc.
 */
export function recipientsOf(args: unknown): string[] {
  if (typeof args !== 'object' || args === null) return []
  const record = args as Record<string, unknown>
  const out: string[] = []
  for (const key of ['to', 'cc', 'bcc']) {
    const value = record[key]
    if (typeof value === 'string') out.push(value)
    else if (Array.isArray(value)) {
      for (const entry of value) if (typeof entry === 'string') out.push(entry)
    }
  }
  return out
}
