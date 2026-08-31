# omp-paperclip-adapter — Roadmap

**Vision:** make oh-my-pi a first-class *organizational runtime* on Paperclip — not a wrapped
CLI, but an employee population with shared credentials, subagent teams, governance-gated
planning, cost intelligence, and session continuity that survives restarts, models, and
machines.

Three architecture generations frame everything below:

- **G1 — today (v0.1.0).** Spawn `omp acp` through the ACPX custom lane. One agent, one
  process, one session. Works; proven live.
- **G2 — fleet.** Many omp employees sharing infrastructure: credential vault, warm process
  pool, model routing, cost governance, session intelligence.
- **G3 — org runtime.** omp's native multi-agent surfaces (subagent registry, collab,
  extensions) exposed as Paperclip org structure — Paperclip manages the *company*, omp
  manages the *teams inside each employee*.

---

## v0.2 — "Reliable employee" (G1 hardened)

*Everything here is adapter-local; no upstream dependency.*

### 1. Process economics
Heartbeats currently pay full spawn + session-init every run (warmHandleIdleMs=0 default),
and the free-tier model burned 28 min on one heartbeat. Ship the economics layer:
- `warmHandleIdleMs` guidance + verification (sessionReused flag in usageJson).
- `model` pinning per employee with rate-card awareness — `omp models ls --json` already
  gives us `cost` + `contextWindow`; surface a "cost per heartbeat" estimate in the board
  agent form (input tokens × rate card, from the run history of prior heartbeats).
- `timeoutSec` presets tuned per model tier (we measured: free preview tier needs >20 min
  for a 45k-token context; fast tiers don't).

### 2. Thinking + model controls over ACP
omp exposes `session/set_config_option` for `thinking` and per-session model switching.
Verify engine control-key forwarding for custom agents, then wire Paperclip's thinking/model
pickers to live session options instead of spawn-time-only flags. Fallback if the engine
won't forward: upstream request (small).

### 3. MCP passthrough
`session/new` accepts `mcpServers[]` (stdio/http/sse). Wire company-configured MCP servers
through so omp employees reach tool parity with claude/codex agents. Verify how much the
ACPX engine forwards already; fill the gap in `buildOmpAcpConfig`.

### 4. Plan-mode governance loop
omp's plan mode (`session/set_mode plan`, gated on `plan.enabled`) is read-only drafting —
a natural fit for Paperclip's approval-before-execution governance. Target flow: issue
assigned → agent drafts plan in plan mode → plan lands as a work product → board approves →
execution heartbeat runs with the plan as context. Requires verifying which side answers
plan elicitation under acpx (auto-approves today when client lacks `elicitation.form` —
we may want acpx to answer it properly).

### 5. Skills without native sync
Engine marks skills `custom_unsupported`; omp runs skills from prompt text. Inject desired
Paperclip skills into the instructions file / run prompt so employees honor company skills.
Acceptance: a company skill is invoked by an omp agent during a heartbeat.

### 6. Cost truth end-to-end
Today: `costStatus: "unpriced"`, `billingType: "metered_api"` — honest but opaque. Combine
`omp models ls --json` rate cards (we parse them, incl. `priced` flag) with per-run usage to
compute and display real USD per heartbeat, and mark declared-free models distinctly from
unpriced ones. Stretch: `_omp/usage` aggregate reports for account-level budget views.

---

## v0.3 — "Fleet" (G2)

*The employee population becomes the unit of engineering.*

### 7. Credential fleet via auth-broker
One `omp auth-broker serve` vault backing every omp employee, instead of each agent resolving
its own credentials. `auth-gateway serve` as the metering proxy: all provider traffic flows
through one observable, budget-enforceable choke point. Adapter ships a `credentialMode:
local | broker` config; Paperclip secrets bind to broker tokens, never raw keys.

### 8. Warm process pool
Beyond per-agent warm handles: a shared supervisor keeping N omp ACP processes hot across
the fleet, with session-affinity routing. Cuts per-heartbeat latency fleet-wide; needs care
with the hot-restart classifier (pipied-stdio runs are server-stdio bound — see upstream
#11607) and process-group cleanup on service restart.

### 9. Session intelligence
omp's ACP advertises `loadSession / resume / fork / close` and `_omp/sessions/listAll` —
none of which we exploit beyond linear resume:
- **Fork for retries:** a failed heartbeat forks the session instead of resuming a possibly
  poisoned context; poisoned-session detection (the gemini_local class of bugs) becomes
  cheap.
- **Compaction policy:** long-lived employees hit context walls; adopt the engine's
  session-rotation triggers with omp's compaction semantics.
- **Session browser:** `_omp/projects/list` + `_omp/chats/byCwd` rendered as a Paperclip
  work-product — every employee's full history inspectable from the board.

### 10. Model failover chains
Provider-quota exhaustion is the classic unattended-fleet failure (upstream #12123 added it
for Claude subscriptions). Implement adapter-level failover: on provider-4xx/quota error
classification, re-invoke the turn against the next model in a configured chain
(e.g. `axon-compat/glm-5.2 → openrouter/... → ...`), with the chain stored per agent.

### 11. Observability export
omp ships OTLP export (`OTEL_EXPORTER_OTLP_*`). Wire it into Paperclip's telemetry pipeline:
per-employee traces, token/cost metrics, turn latency histograms. Fleet dashboards without
scraping transcripts.

---

## v1.0 — "Org runtime" (G3)

*The ambitious tier. Each item needs upstream omp surface (all verified to exist in source).*

### 12. Subagent teams inside one employee
omp has a full subagent subsystem: `AgentRegistry`, `task`/`hub` tools, persisted subagents
that revive cold from disk. A Paperclip employee becomes a *manager*: its heartbeat spawns
omp subagents for parallel work, aggregates results. Paperclip's org chart stays
human-facing; omp runs the team internally. RPC mode's `set_subagent_subscription` /
`get_subagent_messages` (the ~50-method internal surface) is the likely lane — richer than
ACP, and the fork boundary is contained inside our adapter.

### 13. ExtensionAPI bridge — skills become native tools
omp's `ExtensionAPI` (`registerTool`, event bus, custom commands) via `--extension`. Build a
`paperclip-bridge` omp extension: Paperclip company skills surface as *native omp tools*
(not prompt-injected text), and omp tool events stream back into Paperclip's activity log.
This is the bidirectional integration prompt-injection can never be.

### 14. Headless collab — shared sessions between employees
omp's collab subsystem (`collab/host.ts`, E2E-encrypted framed protocol) is TTY-only today
(`omp join`), but the host side is a protocol server. A headless collab host would let two
Paperclip employees share one live omp session — pair-programming agents. Long-shot; needs
upstream blessing for non-TTY host operation.

### 15. Worktree-aware execution
`omp worktree list/clear` + the worktree.base config integrate with Paperclip's project
execution workspaces: each assigned issue runs in an omp-managed worktree, PRs reference the
worktree, `worktree clear` rides cleanup. Removes workspace collisions between concurrent
employees on one repo.

### 16. Embeddable runtime (the C option, revisited)
If oh-my-pi ever ships a runtime-neutral SDK (no `Bun.*` in the public surface, compiled
ESM), the adapter's ACP boundary is the seam — swap spawn for in-process without touching
Paperclip config. Track upstream; don't build.

---

## Upstream contributions (Paperclip)

| Item | Size | Unlocks |
|---|---|---|
| Mobile/web-worker fallback in `sandboxed-parser-worker.ts` | S | Rendered transcripts on every device (live pain today) |
| Custom-lane control-key forwarding (thinking/effort) | S–M | Item 2 without omp-side changes |
| Per-agent config on `refreshModels`/`detectModel` hooks | M | Discovery honors `command` overrides |
| `supportsAcp`-style capability for engine-backed externals | S | Honest board capability display |

## Upstream requests (oh-my-pi)

| Item | Why |
|---|---|
| Model-catalog refresh over ACP (`_omp/models/refresh`) | Fleet-wide model updates without side-channel CLI races |
| Headless collab host | Item 14 |
| Runtime-neutral SDK | Item 16 |
| `--list-models`-equivalent stable flag | Already covered by `omp models --json`; formalize as contract |

---

## Completed

- **2026-08-31 — v0.5.0 (Fleet runtime).** `ompEnv` env-threading (fixes env-blind side-channel
  credential resolution; per-env catalog cache), `credentialMode: local|broker` (consumption-only,
  fail-closed, secret_ref), per-agent `retry.fallbackChains` via `PI_CONFIG_FILES`, OTLP export
  diagnostic (protocol-mismatch warn), MCP HTTP-lane count on the run path, usage & cost work product
  (broker `/v1/usage` + rate-card estimate incl. cache-read). Items 3/7/10/11 shipped in adapter-local
  scope. Remaining G2: warm process pool (item 8), gateway metering proxy, plugin-SDK session panel,
  and fork/compaction un-gating (blocked on the cross-run resume fingerprint instability).


- **2026-08-28 — v0.4.0 (Session runtime).** Side-channel session reads (initialize-only),
  fork-as-action via operator config + `sessionParams.acpSessionId` override + per-run
  `warmHandleIdleMs`, compaction rotation (adapter-owned run counters + fingerprint bust),
  session browser work products (provider `omp-session`), governance config schema
  (force-fresh, fork, rotation thresholds), static `sessionManagement` declaration.
  Plugin-SDK session panel deferred to a v0.5 candidate.

- **2026-08-26 — v0.1.0 (G1).** ACP-lane adapter: spawn `omp acp` via ACPX custom lane,
  `omp models ls --json` discovery with rate cards, ACP handshake + active-model probe,
  five-check testEnvironment, self-contained ui-parser bundle, 25 unit tests. Installed and
  live-verified on instance `default`: handshake pass, heartbeat succeeded end-to-end
  (48 tool calls, 262k in / 8.8k out tokens, correct governance-gate + retry-contract
  behavior observed in the agent's own summary).
