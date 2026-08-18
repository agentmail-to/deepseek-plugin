# harness-test

Boots `dsh-agentmail` inside a **real Cordis composition** with the actual harness
service packages. Both scenarios are **keyless** — no LLM adapter is mounted, so no
model is ever called; tools are driven directly through the real `ctx.tools` pipeline.

```sh
npm run build            # from the repo root; these load ../lib
export AGENTMAIL_API_KEY=...
export AGENTMAIL_INBOX_ID=you@agentmail.to
./run.sh tools           # scenario 1
./run.sh agents          # scenario 2
```

| Scenario | Mounts | Verifies |
|---|---|---|
| `tools` | `dsh-system-prompt`, `dsh-tools` + our tools/identity/approval | registration on the real registry, identity section reaching the assembled prompt, the `tools/pre-execute` gate, the `ctx.tools.guard()` allowlist, and `defineTool` argument validation |
| `agents` | the full spine (`dsh-session`, `dsh-llm`, `dsh-agent`, `dsh-agent-loop`, JSONL persistence) + our inbound driver | `agents.create/get/resume`, `agent.inject`, `AgentHandle.dispose`, and the persisted-branch `exists()` probe |

Scenario 2 writes session logs to `./.sessions` (gitignored). Run it twice: the second
run exercises the persisted branch against logs the first run left behind, which is the
real restart scenario.

## Why this exists

Unit tests use fakes, and fakes agree with whatever you assumed. Running here found two
bugs that fakes could not:

- Cordis **enforces `inject`** — reading an undeclared `ctx.<service>` throws rather than
  returning `undefined`, so the inbound driver's optional use of `sessionPersistence` had
  to move to a nested `ctx.inject()` fiber.
- With approval enabled, the `ask` short-circuited the allowlist guard, so a forbidden
  recipient produced an approval prompt instead of a denial. The gate now denies first.
