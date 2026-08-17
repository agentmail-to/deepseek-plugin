import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'probe-agents'
export const inject = ['agents']

export function apply(ctx) {
  // Same optional-service idiom the plugin now uses.
  let persistence
  ctx.inject(['sessionPersistence'], s => { persistence = s.sessionPersistence })

  void (async () => {
    await new Promise(r => setTimeout(r, 2500))
    const pass = [], fail = [], skip = []
    const check = (l, ok, d = '') => (ok ? pass : fail).push(l + (d ? ` — ${d}` : ''))

    // A cold first run has no log from a previous process, and a log written
    // moments ago may not have flushed yet. Those checks are only meaningful
    // on a second run, which is also the real scenario: restart, then resume.
    const target = 'agentmail-2f4aef19-0068-488f-85e7-7bfcc6a6d199'
    let priorLog = false
    if (persistence) {
      try { priorLog = (await persistence.list()).some(h => h.id === target) } catch {}
    }
    const checkPersisted = (l, ok, d = '') => {
      if (!priorLog) skip.push(l + ' — skipped: cold run, no log from a previous process')
      else check(l, ok, d)
    }

    // Exactly the calls sessionPort makes in src/inbound.ts.
    const threadId = '2f4aef19-0068-488f-85e7-7bfcc6a6d199'   // a real AgentMail thread id
    const sid = SessionId('agentmail-' + threadId)
    let handle
    try {
      handle = await ctx.agents.create({ sessionId: sid, meta: { cwd: process.cwd() } })
      check('agents.create() with a thread-derived session id', true, String(sid))
    } catch (e) {
      check('agents.create() with a thread-derived session id', false, String(e).slice(0, 220))
    }

    if (handle) {
      check('agents.get() returns the created agent', ctx.agents.get(sid) !== undefined)
      try {
        handle.agent.inject(createUserMessage({
          content: [{ type: 'text', text: 'seeded thread history' }],
          source: { kind: 'plugin', plugin: 'dsh-agentmail' },
        }))
        check('agent.inject() accepts a plugin-sourced message', true)
      } catch (e) {
        check('agent.inject() accepts a plugin-sourced message', false, String(e).slice(0, 220))
      }

      check('optional sessionPersistence resolved via ctx.inject', persistence !== undefined)
      if (persistence) {
        try {
          const headers = await persistence.list()
          const ids = headers.map(h => h.id)
          checkPersisted('persistence.list() exposes .id for the exists() probe',
            ids.includes(String(sid)), `${headers.length} session(s)`)
        } catch (e) {
          check('persistence.list() exposes .id for the exists() probe', false, String(e).slice(0, 180))
        }
      }

      try { await handle.dispose(); check('AgentHandle.dispose()', true) }
      catch (e) { check('AgentHandle.dispose()', false, String(e).slice(0, 180)) }
      check('disposed agent is no longer live', ctx.agents.get(sid) === undefined)

      // The persisted branch: after disposal the log must still be findable,
      // which is what makes disposal non-destructive.
      if (persistence) {
        try {
          const ids = (await persistence.list()).map(h => h.id)
          checkPersisted('session log survives disposal (persisted branch works)', ids.includes(String(sid)))
        } catch { checkPersisted('session log survives disposal (persisted branch works)', false) }
      }

      try {
        const resumed = await ctx.agents.resume({ resumeSessionId: sid })
        check('agents.resume() reattaches to the persisted session', true)
        await resumed.dispose()
      } catch (e) {
        check('agents.resume() reattaches to the persisted session', false, String(e).slice(0, 220))
      }
    }

    console.log('\n============ AGENTS / INBOUND PROBE ============')
    for (const p of pass) console.log('  PASS  ' + p)
    for (const s of skip) console.log('  SKIP  ' + s)
    for (const f of fail) console.log('  FAIL  ' + f)
    console.log(`============ ${pass.length} pass / ${fail.length} fail / ${skip.length} skip ============\n`)
    process.exit(fail.length === 0 ? 0 : 1)
  })()
}
