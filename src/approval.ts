/**
 * Outbound policy: recipient allowlist and human approval before mail leaves.
 *
 * Two mechanisms with different strengths, deliberately:
 * - `ctx.tools.guard()` for the allowlist, because a monotonic final deny is
 *   what an invariant needs — no later listener can undo it.
 * - `tools/pre-execute` for the approval `ask`, because that one is an
 *   interactive, reorderable policy a deployment may legitimately replace.
 * @module dsh-agentmail/approval
 */
import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import { Config } from './config.js'
import { bareAddress, recipientAllowed, recipientsOf } from './naming.js'
import { OUTBOUND_TOOLS } from './tools.js'

export const name = 'agentmail-approval'
export const inject = ['tools']
export { Config }

const OUTBOUND = new Set<string>(OUTBOUND_TOOLS)

/** Outcome of the allowlist check. */
export interface AllowlistVerdict {
  allowed: boolean
  rejected: string[]
}

/**
 * Check every recipient of a call against the allowlist.
 *
 * `agentmail_send_draft` carries no recipients in its arguments — the draft
 * holds them — so it cannot be screened here and is reported as allowed. The
 * approval gate still covers it.
 * @param toolName - the tool being called.
 * @param args - model-supplied arguments, unvalidated.
 * @param allowlist - configured entries.
 * @returns the verdict and any rejected addresses.
 */
export function checkAllowlist(
  toolName: string,
  args: unknown,
  allowlist: readonly string[],
): AllowlistVerdict {
  if (!OUTBOUND.has(toolName) || allowlist.length === 0) return { allowed: true, rejected: [] }
  const recipients = recipientsOf(args)
  const rejected = recipients.filter(recipient => !recipientAllowed(recipient, allowlist))
  return { allowed: rejected.length === 0, rejected: rejected.map(bareAddress) }
}

/**
 * Register outbound policy.
 * @param ctx - plugin context.
 * @param config - validated configuration.
 */
export function apply(ctx: Context, config: Config): void {
  if (config.allowedRecipients.length > 0) {
    // A guard returns a deny reason, or undefined to stay out of the way.
    ctx.tools.guard((exec): string | undefined => {
      const verdict = checkAllowlist(exec.name, exec.arguments, config.allowedRecipients)
      return verdict.allowed
        ? undefined
        : `Recipient not permitted by dsh-agentmail allowedRecipients: ${verdict.rejected.join(', ')}`
    })
  }

  if (!config.requireApprovalForSend) return

  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    if (!OUTBOUND.has(exec.name)) return next()

    // Deny before asking. The guard above is the monotonic backstop, but if the
    // ask ran first a human would be prompted to approve a send that policy
    // forbids — and the safety of that would depend on whether guards still run
    // after approval resolves. Checking here makes the outcome order-independent.
    const verdict = checkAllowlist(exec.name, exec.arguments, config.allowedRecipients)
    if (!verdict.allowed) {
      return {
        kind: 'deny',
        reason: `Recipient not permitted by dsh-agentmail allowedRecipients: ${verdict.rejected.join(', ')}`,
      }
    }

    const recipients = recipientsOf(exec.arguments)
    const target = recipients.length > 0 ? recipients.join(', ') : 'the draft recipients'
    return { kind: 'ask', reason: `Send email to ${target}?` }
  })
}
