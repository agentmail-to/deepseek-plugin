/**
 * Shared configuration schema for every `dsh-agentmail` plugin entry point.
 * @module dsh-agentmail/config
 */
import Schema from '@deepseek-ai/schemastery'

/** Inbound delivery strategy. `websocket` falls back to `poll` on its own. */
export type InboundMode = 'websocket' | 'poll' | 'off'

/** Resolved plugin configuration. */
export interface Config {
  apiKey: string
  baseUrl?: string
  inboxId?: string
  autoCreateInbox: boolean
  readOnly: boolean
  requireApprovalForSend: boolean
  allowedRecipients: string[]
  maxBodyChars: number
  timeoutMs: number
  maxRetries: number
  inbound: {
    mode: InboundMode
    pollIntervalMs: number
    wakeIdleAgent: boolean
    reconnectAttempts: number
    connectionTimeoutSeconds: number
    eventTypes: string[]
  }
  threadSessions: {
    enabled: boolean
    sessionIdPrefix: string
    fallbackSessionId: string
    idleDisposeMs: number
    maxLive: number
    followupSweepMs: number
    cwd?: string
  }
}

export const Config: Schema<Config> = Schema.object({
  apiKey: Schema.string().required().role('secret')
    .description('AgentMail API key. Prefer a `!!js process.env.AGENTMAIL_API_KEY` reference over a literal.'),
  baseUrl: Schema.string().description('Override the AgentMail API base URL.'),
  inboxId: Schema.string()
    .description('Inbox this deployment owns. Created on first use when absent and `autoCreateInbox` is set.'),
  autoCreateInbox: Schema.boolean().default(true),
  readOnly: Schema.boolean().default(false)
    .description('Register no send/reply/draft/label tools at all. Strictly stronger than the approval gate.'),
  requireApprovalForSend: Schema.boolean().default(true),
  allowedRecipients: Schema.array(Schema.string()).default([])
    .description('Allowlist of addresses or `@domain.com` suffixes. Empty means no recipient restriction.'),
  maxBodyChars: Schema.number().default(8_000)
    .description('Per-message body budget before truncation. Guards the context window against large mail.'),
  timeoutMs: Schema.number().default(30_000),
  maxRetries: Schema.number().default(2),

  inbound: Schema.object({
    mode: Schema.union(['websocket', 'poll', 'off'] as const).default('websocket'),
    pollIntervalMs: Schema.number().default(30_000),
    wakeIdleAgent: Schema.boolean().default(false)
      .description('followup() instead of inject(). Opt-in: waking on inbound mail is an unbounded-cost surface.'),
    reconnectAttempts: Schema.number().default(30),
    connectionTimeoutSeconds: Schema.number().default(10),
    eventTypes: Schema.array(Schema.string()).default(['message.received']),
  }),

  threadSessions: Schema.object({
    enabled: Schema.boolean().default(true)
      .description('One session per email thread. Disable to route all mail into `fallbackSessionId`.'),
    sessionIdPrefix: Schema.string().default('agentmail-')
      .description('Avoid `:` — the JSONL backend escapes it to ~003A in on-disk session directory names.'),
    fallbackSessionId: Schema.string().default('agentmail-inbox'),
    idleDisposeMs: Schema.number().default(15 * 60_000),
    maxLive: Schema.number().default(50).description('Flood cap. Disposal is non-destructive, so eviction order is irrelevant.'),
    followupSweepMs: Schema.number().default(5 * 60_000),
    cwd: Schema.string().description('Absolute working directory for thread sessions. Defaults to process.cwd().'),
  }),
})
