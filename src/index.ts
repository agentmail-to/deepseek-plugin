/**
 * `dsh-agentmail` — give a DeepSeek Harness agent its own email inbox.
 *
 * The bundle mounts four independent plugins so a deployment can disable any
 * one of them from its own patch layer:
 *
 * | entry | role |
 * |---|---|
 * | `dsh-agentmail/tools` | the model-facing tool surface |
 * | `dsh-agentmail/identity` | inbox identity + untrusted-content rules |
 * | `dsh-agentmail/approval` | recipient allowlist + human approval |
 * | `dsh-agentmail/inbound` | inbound mail, thread sessions, follow-ups |
 *
 * @module dsh-agentmail
 */
export { Config, type InboundMode } from './config.js'
export {
  createClient, createRuntime, requestOptions, resolveInboxId, threadIdOf, toRenderable, todayIso,
  type Client, type RawMessage, type Runtime,
} from './client.js'
export {
  bareAddress, dueFollowupLabels, followupDueDate, followupLabel, recipientAllowed, recipientsOf,
  sessionIdFor, threadIdFrom, EVENT_TYPE, FAILURE_EVENTS, FOLLOWUP_LABEL_PREFIX, FRAME,
} from './naming.js'
export {
  defuse, isoTime, renderFailureNotice, renderFollowupNotice, renderInboundNotice, renderMessage,
  renderThread, truncate, UNTRUSTED_CLOSE, UNTRUSTED_OPEN,
  type RenderableMessage, type Truncated,
} from './render.js'
export {
  ThreadSessionRouter,
  type Delivery, type DeliveryBranch, type InjectableAgent, type OwnedAgent, type RouterOptions,
  type SessionPort, type ThreadSeeder,
} from './threads.js'
export { superviseSocket, type SupervisedSocket, type Supervisor, type SuperviseOptions } from './socket.js'
export { findDueFollowups, sweepFollowups, type DueFollowup, type SweepOptions } from './followup.js'
export { checkAllowlist, type AllowlistVerdict } from './approval.js'
export { identityText } from './identity.js'
export { buildTools, OUTBOUND_TOOLS, WRITE_TOOLS, type ThreadSummary } from './tools.js'
