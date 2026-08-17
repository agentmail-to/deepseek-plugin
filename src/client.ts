/**
 * AgentMail client construction and the shared normalization helpers every
 * plugin entry point uses.
 *
 * Because the plugin keeps no local mapping store, AgentMail availability is a
 * hard dependency for session rehydration — retry and timeout policy is owned
 * here rather than left to each call site.
 * @module dsh-agentmail/client
 */
import { AgentMailClient } from 'agentmail'
import type { Config } from './config.js'
import type { RenderableMessage } from './render.js'

/** The subset of the AgentMail SDK this plugin uses. */
export type Client = AgentMailClient

/**
 * Build a client from resolved configuration.
 * @param config - plugin configuration.
 * @returns a configured AgentMail client.
 */
export function createClient(config: Config): Client {
  return new AgentMailClient({
    apiKey: config.apiKey,
    ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
  })
}

/** Per-call options shared by every request this plugin issues. */
export function requestOptions(config: Config, signal?: AbortSignal): {
  timeoutInSeconds: number
  maxRetries: number
  abortSignal?: AbortSignal
} {
  return {
    timeoutInSeconds: Math.max(1, Math.ceil(config.timeoutMs / 1000)),
    maxRetries: config.maxRetries,
    ...(signal === undefined ? {} : { abortSignal: signal }),
  }
}

/**
 * Resolve the inbox this deployment owns, creating it when permitted.
 *
 * A configured `inboxId` is trusted without a round trip; discovery only runs
 * when configuration left it open.
 * @param client - AgentMail client.
 * @param config - plugin configuration.
 * @returns the resolved inbox id.
 * @throws when no inbox exists and creation is disabled.
 */
export async function resolveInboxId(client: Client, config: Config): Promise<string> {
  if (config.inboxId !== undefined && config.inboxId.length > 0) return config.inboxId

  const existing = await client.inboxes.list({ limit: 1 }, requestOptions(config))
  const first = existing.inboxes?.[0]
  if (first !== undefined) return first.inboxId

  if (!config.autoCreateInbox) {
    throw new Error(
      'dsh-agentmail: no inbox configured and none exists. Set `inboxId` or enable `autoCreateInbox`.',
    )
  }
  const created = await client.inboxes.create({}, requestOptions(config))
  return created.inboxId
}

/** Client plus lazily resolved inbox identity, shared by every entry point. */
export interface Runtime {
  readonly client: Client
  readonly config: Config
  /** Memoized inbox resolution; a failure is not cached. */
  inboxId(): Promise<string>
}

/**
 * Build the shared runtime.
 * @param config - plugin configuration.
 * @param client - optional client override, for tests.
 * @returns the runtime.
 */
export function createRuntime(config: Config, client: Client = createClient(config)): Runtime {
  let pending: Promise<string> | undefined
  return {
    client,
    config,
    inboxId() {
      pending ??= resolveInboxId(client, config).catch((error: unknown) => {
        pending = undefined // a transient failure must not poison every later call
        throw error
      })
      return pending
    },
  }
}

/** An AgentMail message shape loose enough to accept SDK and event payloads. */
export interface RawMessage {
  messageId?: string
  message_id?: string
  threadId?: string
  thread_id?: string
  from?: string
  to?: string[]
  cc?: string[]
  subject?: string
  timestamp?: string | Date
  text?: string
  extractedText?: string
  extracted_text?: string
  preview?: string
  labels?: string[]
}

/**
 * Normalize an SDK or WebSocket message payload into the render shape.
 *
 * Event payloads and REST payloads do not always agree on snake vs camel case,
 * so both spellings are accepted rather than trusting one wire form.
 * @param raw - a message from any AgentMail surface.
 * @returns the normalized message.
 */
export function toRenderable(raw: RawMessage): RenderableMessage {
  return {
    messageId: raw.messageId ?? raw.message_id,
    threadId: raw.threadId ?? raw.thread_id,
    from: raw.from,
    to: raw.to,
    cc: raw.cc,
    subject: raw.subject,
    timestamp: raw.timestamp,
    text: raw.text,
    extractedText: raw.extractedText ?? raw.extracted_text,
    preview: raw.preview,
    labels: raw.labels,
  }
}

/**
 * Read a thread id off an arbitrary event payload.
 * @param payload - a WebSocket event or message.
 * @returns the thread id, or undefined when absent.
 */
export function threadIdOf(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const record = payload as Record<string, unknown>
  const direct = record['threadId'] ?? record['thread_id']
  if (typeof direct === 'string') return direct
  const message = record['message']
  return message === undefined ? undefined : threadIdOf(message)
}

/** Today's date as `YYYY-MM-DD` in UTC. */
export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10)
}
