# dsh-agentmail

Give a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) agent its own email
inbox — send, read, search, reply, label, and, the part that makes it an agent rather than a
mail client, **wake up when mail arrives**.

Inbound mail is bound to **one harness session per email thread**, and a thread session that
does not exist yet rebuilds itself from the AgentMail API. There is no local mapping store.

---

## Two ways to install

### The 5-minute on-ramp: the built-in MCP client

The harness ships `@deepseek-ai/dsh-mcp-client`, and AgentMail runs an MCP server. Zero code:

```yaml
- id: mcp-agentmail
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: agentmail
    transport: streamable-http
    url: https://mcp.agentmail.to/mcp
    headers:
      Authorization: !!js '`Bearer ${process.env.AGENTMAIL_API_KEY}`'
```

That gives you `mcp__agentmail__send_message` and friends today. It does **not** give you the
four things below.

### This plugin

```sh
export AGENTMAIL_API_KEY=...
dsh plugin --profile demo add dsh-agentmail
dsh --profile demo
```

| Capability | MCP client | This plugin |
|---|---|---|
| Send / read / search tools | ✅ | ✅ |
| **Inbound mail reaches the agent** | ❌ | ✅ |
| **Bounces reported back**, so a failed send isn't assumed delivered | ❌ | ✅ |
| **Approval + recipient allowlist** before mail leaves | ❌ | ✅ |
| **Follow-ups that survive the conversation ending** | ❌ | ✅ |
| Inbox identity + untrusted-content rules in the system prompt | ❌ | ✅ |

### Local development

```sh
npm install && npm run build
dsh web --patch ./cordis.patch.yml
```

---

## What gets mounted

Four independent plugins, so a deployment can drop any one from its own patch layer:

| Entry | Injects | Role |
|---|---|---|
| `dsh-agentmail/tools` | `tools` | The model-facing tool surface |
| `dsh-agentmail/identity` | `systemPrompt` | Inbox identity and the untrusted-content rules |
| `dsh-agentmail/approval` | `tools` | Recipient allowlist + human approval on outbound |
| `dsh-agentmail/inbound` | `agents` | Inbound mail, thread sessions, follow-up sweep |

## Tools

Ten, curated rather than a mirror of the REST API — every registered schema is paid on every
model request.

| Tool | Notes |
|---|---|
| `agentmail_list_inboxes` | |
| `agentmail_create_inbox` | |
| `agentmail_list_threads` | Cursor-paged, label-filterable |
| `agentmail_get_thread` | Bodies truncated to `maxBodyChars` |
| `agentmail_search` | Relevance-ranked full text |
| `agentmail_send_message` | Idempotency-keyed on the tool call id |
| `agentmail_reply` | `replyAll` opt-in; idempotency-keyed |
| `agentmail_create_draft` | The human-in-the-loop path |
| `agentmail_send_draft` | |
| `agentmail_update_labels` | Workflow state |
| `agentmail_followup` | Due-date label; wakes a cold thread session |

Canonical returns are a programmatic API — ids and fields, never prose to re-parse — so Code
Mode can drive batch triage through `await tools.agentmail_list_threads(...)` in one call.

---

## How thread binding works

The session id is a total function of the thread id:

```
sessionId = "agentmail-" + threadId
```

Inbound mail on thread `T` takes one of three branches:

| Branch | When | What happens |
|---|---|---|
| **live** | an agent is already running | inject just the new message |
| **persisted** | a session log exists on disk | resume it, then inject the new message |
| **fresh** | neither | create it, and seed from `threads.get(threadId)` |

The third branch is why there is no mapping store: **AgentMail is the store.** A session lost
to a restart, a cleared profile, or a different machine rebuilds itself from the API.

Consequences that are handled, and worth knowing:

- **Concurrent mail on one thread** hits an in-flight latch, so two messages arriving inside the
  create window produce one session, not two.
- **Idle disposal is non-destructive.** Sessions idle past `idleDisposeMs` are disposed with no
  eviction ordering to reason about — the log survives, and the API can rebuild regardless.
  `maxLive` is only a flood cap.
- **Outbound-initiated threads** start life in whatever session sent the first mail. When the
  reply arrives, the new thread session seeds from the API, so it knows everything that was
  *said* but not the sending session's private reasoning. Accepted for v1.

Set `threadSessions.enabled: false` to route all mail into one `fallbackSessionId` instead.

## Follow-ups: why not `schedule_create`?

Harness Schedule reminders only fire while a session has a **live root Agent**, and the only
other thing that revives a thread session is inbound mail. But "follow up in 3 days if they
haven't replied" is precisely the case where **no mail arrives** — so a session-local reminder
would never fire.

`agentmail_followup` writes a `dsh-followup-YYYY-MM-DD` label onto the thread instead. One
periodic sweep (`followupSweepMs`) queries for due labels and revives exactly those sessions.
AgentMail is the follow-up index; the plugin keeps no per-session state. The label is cleared
only after delivery succeeds, so a failed sweep retries rather than dropping the follow-up.

Built-in Schedule stays available and correct for reminders *within* an already-live session.

## Security

**Every inbound body is treated as untrusted input.** Bodies are fenced in
`<email-content untrusted="true">` … `</email-content>`, any closing fence inside the body is
neutralized so a crafted email cannot break out of its own block, and the identity section tells
the model that text inside the fences is data — never instructions, no matter who it claims to
be from.

Layered on top:

- `readOnly: true` registers no write tools at all — strictly stronger than any runtime gate.
- `allowedRecipients` is enforced through `ctx.tools.guard()`, a **monotonic** deny no later
  listener can undo.
- `requireApprovalForSend` (default **on**) returns `ask` from `tools/pre-execute`.
- `wakeIdleAgent` defaults to **off**: inbound mail appends context rather than starting a turn.
  Auto-waking on mail is an unbounded-cost surface and turns spam into a prompt injection with a
  budget. Opt in deliberately.

> `agentmail_send_draft` carries no recipients in its arguments — they live on the draft — so the
> allowlist cannot screen it. The approval gate still covers it.

## Configuration

| Key | Default | Notes |
|---|---|---|
| `apiKey` | — | Required. Prefer `!!js process.env.AGENTMAIL_API_KEY`. |
| `inboxId` | discovered | Created on first use when absent |
| `autoCreateInbox` | `true` | |
| `readOnly` | `false` | |
| `requireApprovalForSend` | `true` | |
| `allowedRecipients` | `[]` | Addresses or `@domain.com` suffixes |
| `maxBodyChars` | `8000` | Per-message body budget |
| `timeoutMs` / `maxRetries` | `30000` / `2` | |
| `inbound.mode` | `websocket` | or `poll`, `off` |
| `inbound.wakeIdleAgent` | `false` | |
| `inbound.eventTypes` | `['message.received']` | Same dotted spelling as `eventType` |
| `threadSessions.enabled` | `true` | |
| `threadSessions.sessionIdPrefix` | `agentmail-` | Avoid `:` — see below |
| `threadSessions.idleDisposeMs` | `900000` | |
| `threadSessions.maxLive` | `50` | Flood cap |
| `threadSessions.followupSweepMs` | `300000` | |

## Implementation notes

Three findings from reading the SDK and harness sources that shaped the code:

**The AgentMail WebSocket's auto-reconnect only half-works.** A network drop closes with 1006
and reconnects correctly. But an error or connection timeout runs `_handleError` →
`_disconnect(undefined)`, whose `code` defaults to **1000**, and `_handleClose` disables
`_shouldReconnect` for code 1000 — so auto-reconnect is silently dead for that socket's life.
Exhausting `maxRetries` dispatches no event at all. `src/socket.ts` supervises: 1006 is left to
the SDK, and a code-1000 close we did not initiate triggers a **brand-new socket**. It must be
new — `WebsocketsSocket.connect()` re-registers all four handlers on an array-backed listener
map, so reusing a live socket would process every inbound email twice.

**`connect()` resolves with the socket already OPEN.** An `on('open')` handler registered after
the `await` therefore never fires — the subscription is never sent and not one inbound message
ever arrives. The supervisor checks `readyState` and fires the open path itself when it has
already missed the event. This was found only by running against the live API; fakes that
dispatch `open` manually cannot catch it. `open` still fires normally after a reconnect, so both
paths run the same subscribe-and-backfill code.

**The event discriminant is `eventType`, not `type`, and it is dotted.** The SDK's TypeScript
union says `type: 'message_received'`, but the SDK parses with `skipValidation: true` and passes
the raw payload through, so those types describe a shape the server never sends. The real
envelope, verified live, is:

```jsonc
{
  "type": "event",                    // always 'event' ('subscribed' for the ack)
  "eventType": "message.received",    // the real discriminant, same spelling as the filter
  "eventId": "aac9625aa62a…",
  "message": { /* … */ },
  "thread":  { /* … */ }
}
```

There is exactly one spelling to know: the subscribe filter and `eventType` use the same dotted
string.

**The event can beat thread materialization.** `threads.get` may briefly report zero messages for
a thread whose event just arrived. The triggering message is always in the notice, so an empty
seed is skipped rather than injected. Inbound messages are also deduplicated by `messageId`,
because post-reconnect backfill overlaps the live stream.

**Session ids reach the filesystem safely, but `:` is ugly.** `SessionId()` is a pure type brand
with no runtime validation, and the JSONL backend escapes ids through `encodeSegment`, keeping
only `[A-Za-z0-9._-]` literal. AgentMail thread ids (`thread_456def`) pass through verbatim. A
`:` in the prefix would become `~003A` in on-disk directory names, hence the `-` default.

**AgentMail availability is a hard dependency.** Trading local state for API round trips is the
core design choice here; retry and timeout policy therefore lives in `src/client.ts` rather than
at each call site.

## Development

```sh
npm run typecheck   # tsc --noEmit over src and tests
npm test            # 73 unit tests, no network
npm run build       # compile to lib/
```

Tests run against fakes, so no API key is needed. Coverage focuses on what would be expensive to
get wrong: the untrusted-content fencing, the concurrency latch, socket supervision, idempotency
keys, the allowlist, and the follow-up retry semantics.

## License

MIT
