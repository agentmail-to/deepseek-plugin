/**
 * The follow-up sweep.
 *
 * Harness Schedule reminders only fire while a session has a live root Agent,
 * and our only other revival trigger is inbound mail — which is exactly what is
 * absent when the reminder is "follow up if they haven't replied". So the
 * intent lives in AgentMail as a due-date thread label, and one periodic query
 * finds it. AgentMail is the follow-up index; we keep no per-session state.
 * @module dsh-agentmail/followup
 */
import { requestOptions, todayIso, type Runtime } from './client.js'
import { dueFollowupLabels, FOLLOWUP_LABEL_PREFIX } from './naming.js'
import { renderFollowupNotice } from './render.js'
import type { ThreadSessionRouter } from './threads.js'

/** One thread carrying at least one due follow-up label. */
export interface DueFollowup {
  threadId: string
  dueDate: string
  labels: string[]
}

/** Options for {@link sweepFollowups}. */
export interface SweepOptions {
  runtime: Runtime
  router: ThreadSessionRouter
  /** Clock, injected for tests. */
  today?: () => string
  onError?: (error: unknown, context: string) => void
}

/**
 * Find threads whose follow-up label has come due.
 *
 * Listing is by label prefix where the API allows it; the due-date comparison
 * is local because label values encode the date.
 * @param runtime - client and inbox identity.
 * @param today - ISO comparison date.
 * @returns the due follow-ups.
 */
export async function findDueFollowups(runtime: Runtime, today: string): Promise<DueFollowup[]> {
  const inboxId = await runtime.inboxId()
  const response = await runtime.client.inboxes.threads.list(inboxId, {
    limit: 100,
  }, requestOptions(runtime.config))

  const due: DueFollowup[] = []
  for (const thread of response.threads ?? []) {
    const labels = thread.labels ?? []
    if (!labels.some(label => label.startsWith(FOLLOWUP_LABEL_PREFIX))) continue
    const dueLabels = dueFollowupLabels(labels, today)
    const earliest = dueLabels[0]
    if (earliest === undefined) continue
    due.push({
      threadId: thread.threadId,
      dueDate: earliest.slice(FOLLOWUP_LABEL_PREFIX.length),
      labels: dueLabels,
    })
  }
  return due
}

/**
 * Run one sweep: revive each due thread's session and clear its label.
 *
 * The label is removed only after delivery succeeds, so a failed sweep retries
 * on the next tick rather than dropping the follow-up.
 * @param options - sweep dependencies.
 * @returns the thread ids delivered to.
 */
export async function sweepFollowups(options: SweepOptions): Promise<string[]> {
  const { runtime, router } = options
  const today = (options.today ?? todayIso)()
  const delivered: string[] = []

  let due: DueFollowup[]
  try {
    due = await findDueFollowups(runtime, today)
  } catch (error) {
    options.onError?.(error, 'followup sweep')
    return delivered
  }

  for (const followup of due) {
    try {
      // A follow-up is the one case where waking is the point: nothing else
      // will start this turn, because no mail is arriving.
      const result = await router.deliver(
        followup.threadId,
        renderFollowupNotice(followup.threadId, followup.dueDate),
        true,
      )
      if (result === undefined) continue

      const inboxId = await runtime.inboxId()
      await runtime.client.inboxes.threads.update(inboxId, followup.threadId, {
        removeLabels: followup.labels,
      }, requestOptions(runtime.config))
      delivered.push(followup.threadId)
    } catch (error) {
      options.onError?.(error, `followup ${followup.threadId}`)
    }
  }

  return delivered
}
