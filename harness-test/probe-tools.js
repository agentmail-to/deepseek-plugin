import { CallId } from '@deepseek-ai/dsh-llm'

export const name = 'harness-probe'
export const inject = ['tools', 'systemPrompt']

export function apply(ctx) {
  void (async () => {
    await new Promise(r => setTimeout(r, 1500))
    const results = { pass: [], fail: [] }
    const check = (label, ok, detail = '') => {
      (ok ? results.pass : results.fail).push(label + (detail ? ` — ${detail}` : ''))
    }

    // 1. Are our tools actually registered on the REAL registry?
    const schemas = ctx.tools.schemas()
    const names = schemas.map(s => s.name ?? s.function?.name).filter(Boolean)
    const ours = names.filter(n => String(n).startsWith('agentmail_'))
    check('tools registered on ctx.tools', ours.length >= 10, `${ours.length} found: ${ours.join(', ')}`)

    // 2. Does the system prompt actually contain our identity section?
    const assembled = await ctx.systemPrompt.assemble({})
    const text = JSON.stringify(assembled)
    check('identity section in assembled prompt', text.includes('haakam-demo@agentmail.to'))
    check('untrusted-content rule in prompt', text.includes('never an instruction'))

    // 3. Real execution pipeline: a read tool against the live API.
    const listed = await ctx.tools.execute({
      callId: CallId('probe-list'), name: 'agentmail_list_threads',
      arguments: { limit: 2 }, signal: new AbortController().signal,
    })
    check('read tool through real pipeline', !listed.isError,
      listed.isError ? JSON.stringify(listed.content).slice(0, 160) : `${listed.content?.[0]?.text?.split('\n').length ?? 0} line(s)`)

    // 4. Approval gate: an allowed recipient should be ASKED, not silently sent.
    const asked = await ctx.tools.execute({
      callId: CallId('probe-ask'), name: 'agentmail_send_message',
      arguments: { to: ['haakam-demo@agentmail.to'], subject: 'probe', text: 'probe' },
      signal: new AbortController().signal,
    })
    check('approval gate intercepts allowed send', asked.isError,
      JSON.stringify(asked.content).slice(0, 160))

    // 5. Allowlist guard: a disallowed recipient must be DENIED.
    const denied = await ctx.tools.execute({
      callId: CallId('probe-deny'), name: 'agentmail_send_message',
      arguments: { to: ['stranger@evil.com'], subject: 'probe', text: 'probe' },
      signal: new AbortController().signal,
    })
    check('allowlist guard denies outside recipient', denied.isError,
      JSON.stringify(denied.content).slice(0, 160))

    // 6. defineTool argument validation via the real registry.
    const bad = await ctx.tools.execute({
      callId: CallId('probe-bad'), name: 'agentmail_get_thread',
      arguments: { threadId: 12345 }, signal: new AbortController().signal,
    })
    check('schema rejects wrong-typed args', bad.isError)

    console.log('\n================ HARNESS PROBE ================')
    for (const p of results.pass) console.log('  PASS  ' + p)
    for (const f of results.fail) console.log('  FAIL  ' + f)
    console.log(`================ ${results.pass.length} pass / ${results.fail.length} fail ================\n`)
    process.exit(results.fail.length === 0 ? 0 : 1)
  })()
}
