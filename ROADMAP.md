# omp-paperclip-adapter — Roadmap

**Vision:** make oh-my-pi a first-class *organizational runtime* on Paperclip — not a wrapped
CLI, but an employee population with shared credentials, subagent teams, governance-gated
planning, cost intelligence, and session continuity that survives restarts, models, and
machines.

**Shape of the integration.** One employee, two lanes:

- **ACP lane (today)** — `omp acp` through Paperclip's ACPX engine. Governed, resumable,
  permission-proxied. Everything v0.1–v0.8 built lives here.
- **RPC lane (v1.0)** — `omp --mode rpc` for the surfaces ACP cannot carry: subagent
  control, host tools, live steering, side questions. Same employee, second transport.

**Priority order: correctness → containment → spend truth → fleet → org runtime.**
v0.9 repaired the features that could not execute (no run token, wrong SQL) and fenced the data that
could cross tenant lines (shared `~/.omp`). v0.10 is next, limited to work whose lever exists in the
current engine.

## Architecture direction — decided 2026-10-30 (supersedes the v1.0 framing)

The product is an **employee runtime**, not an adapter: a thin Paperclip adapter over a per-instance
**host supervisor** that owns omp processes, sessions, leases, credential placement and a run ledger.
The run lane moves to `omp --mode rpc` (warm workers, `set_host_tools`, explicit settlement,
`get_session_stats`); ACP stays as the probe lane for `session/list`, `_omp/*`, `session/fork` and
model discovery. The engine lane was removed inside the v0.x line — **there is no v1.0 cut**.

| Release | Lands | Gate |
|---|---|---|
| v0.11 | **shipped in 0.11.0**: four behaviour-preserving cuts (ACP client extraction, side-channel port, one overlay writer, executor split) | identical behaviour, cycles 0, largest file ≤300 |
| v0.12 | **shipped in 0.12.0**, superseded by 0.15.0: supervisor, RPC worker with warm reuse, host-tool delivery, run ledger + run lease, steering flag | two heartbeats → one worker, one `open_session`; `kill -9` leaves no orphan |
| v0.13 | **shipped in 0.13.0**: subagent observability on the managed lane (bounded events + settlement snapshot) | redaction fixture proves no credential or prompt text |
| v0.14 | **shipped in 0.14.0**: pin bump, three shim deletions, `errorFamily`/`retryNotBefore`, capability probes replace the minor gate, conformance project in CI | probe a capability-less fake → warn not crash |
| v0.15 | **shipped in 0.15.0**: engine run path deleted; the supervisor is the only lane; `executionMode` gone | `acpx-engine/execute` and `executionMode` both unreachable from `src/` |

Non-negotiables: one run path (the supervisor); rollback means reinstalling the previous release, not
flipping a config key; the bridge stays one self-contained bundle; no credential ever enters a warm
worker's environment.

---

## Where this revision stands (assessed 2026-10-30)

Verified against **omp v18.13.1** (`0838d2a`) and **paperclip HEAD** (`3edba11`,
2026-10-26). Item numbers are stable because the changelog references them; this table says
where each one moved and why.

| Old item | Verdict | Reason |
|---|---|---|
| 1 process economics | **split** | Warm-process reuse is discarded by the engine whenever a live run-scoped credential is present (`settlement-sequence.ts`, `execute.ts`), so the pool is upstream-blocked. Cold-start economics move to item 24 (`--restore`, `-p --wait-async`). |
| 2 thinking/model controls | **v0.10, re-scoped** | The engine forwards `model` for custom agents but the thinking key as `effort`, which omp rejects (omp accepts `mode`/`model`/`thinking`). Fix belongs in a config overlay, not `agentCommand` (no fingerprint rotation). |
| 3 MCP passthrough | **v0.10, split** | HTTP forwarding already works for the custom lane; the adapter contributes only a count. Managed gateways and stdio servers are upstream allowlist/type gaps. Delivery mode (`runtimeToolDelivery`) is P0, item 17. |
| 4 plan-mode governance | **parked: do not enable** | With no `elicitation/form` client, omp auto-approves the plan (`acp-agent.ts`: `if (!supportsForm) return true`). Enabling plan mode today deletes the approval step; the extension escape hatch (`plan_review_requested`) is TUI-only. |
| 5 skills without native sync | **shipped (v0.7)** | Replaced by the lazy skill bridge; residual is per-company directory isolation (item 18). |
| 6 cost truth | **v0.9, promoted** | `unpricedUsagePolicy` defaults to `block`, and the engine never emits `costStatus`/`pricingProvenance`, so an unpriced model stalls the employee at the budget gate. Now item 20. |
| 7 credential fleet | **shipped (v0.5)** | Broker mode done. Remaining lever is `auth-gateway serve --clients` for per-employee model/account grants (v0.10). |
| 8 warm process pool | **parked: upstream** | Same credential-rebind gate as item 1. Not an adapter backlog item. |
| 9 session intelligence | **v0.9 + v0.10** | Fork/browser shipped. Correctness (fork cwd precondition, lease, context pressure) is item 21; ACP `session/list`, compaction alignment stay in v0.10. |
| 10 failover chains | **v0.10, re-scoped** | Chain writing works but only `default` is written, which never applies to model-kind roles; the useful knobs are `fallbackOn`, `waitForUsageReset`, `fallbackRevertPolicy`. |
| 11 OTLP export | **parked: upstream** | Paperclip's launch builder is hardcoded to claude/codex; any other harness resolves `unsupported_harness` with no launch. |
| 12 subagent teams | **v1.0, unblocked** | ACP has no subagent surface, but RPC exposes `set_subagent_subscription`, `get_subagents`, `get_subagent_messages`, `cancel_subagent`, `steer_subagent`. Needs an executor, not a feature. |
| 13 ExtensionAPI bridge | **shipped (v0.7/v0.8)** | Guardrails, budget, approvals, skill tools all live. |
| 14 headless collab | **parked: upstream** | `CollabHost` is typed to the TUI context and touches eight UI-only members; `omp join` refuses non-TTY. |
| 15 worktree-aware execution | **obsolete** | Paperclip owns per-run `git_worktree` execution and workspace finalize. The correct posture is the reverse: keep omp out of worktree management. |
| 16 embeddable runtime | **re-scoped, parked** | The in-process SDK is Bun-only. The process boundary is the seam that matters: first-party RPC clients exist in Go, Python and Rust. |
| — | **17–26 new** | Findings that were never on this roadmap; see below. |

---

## P0 — v0.9 "Correctness & containment" — **shipped in 0.9.0 (2026-10-30)**

Items 17–23 below are done; `CHANGELOG.md` carries the release notes and the honest limits. The
detail is kept as the record of what shipped, with one correction: items 17 and 18 landed in the
order shown, and item 18's fence is `sessionScope` (`shared` by default, `isolated` broker-only),
not an unconditional per-agent dir.

### 17. Run identity and control-plane delivery

The adapter never declares `supportsLocalAgentJwt`, so Paperclip mints no run token, so the
engine never sets `PAPERCLIP_API_KEY`. Consequences: session-snapshot and usage work products
return `no run auth token available`, and the bridge's approval POST fails closed with
`governance env unavailable`. The local guardrail rail still denies correctly — the human
round-trip and both work products are dead.

- Declare `supportsLocalAgentJwt: true`, `runtimeToolDelivery: "native_mcp"`,
  `supportsInstructionsBundle` + `instructionsPathKey`, and `getQuotaWindows`.
- Read connection tools from the declared delivery channel; today `paperclipRuntimeTools` is
  never read, so Paperclip connection tools are dropped entirely.
- Acceptance: one live heartbeat produces a run token, a posted work product, a readable
  approval verdict, and a non-zero MCP server count.

### 18. Per-employee data fence

Every employee shares `~/.omp`: sessions, titles, model cache, auth state, extensions. The
session browser posts a **global** `_omp/sessions/listAll` snapshot to the issue, so one
company's board can display another company's sessions, and any employee can load another's
session id.

- Set `PI_CODING_AGENT_DIR` per agent (the state dir already exists per company/agent) and
  pass the same value to side channels.
- Replace the global listing with ACP `session/list` scoped to the run's cwd; keep
  `_omp/*` only as an explicitly operator-gated diagnostic.
- Add retention: scheduled `omp gc --apply` per agent dir; redact with `/dump anon` before
  anything becomes a work product.
- Acceptance: two agents in two companies see disjoint session sets; an unset
  `PI_CODING_AGENT_DIR` is treated as a misconfiguration warning, not a silent default.

### 19. Repair features that report success but are dead

- **Session-panel plugin**: SQL uses `heartbeat_runs.ended_at` (schema: `finished_at`) and
  `cost_events.run_id` (schema: `heartbeat_run_id`), and `cost_cents` is `numeric` returned
  as a string, so even a fixed query renders $0.00. Fix the query, the type handling, and add
  a schema-derived fixture instead of a mocked one.
- **`refreshModels` does not refresh**: `force: true` only bypasses the adapter's own 5-minute
  cache. Run `omp models refresh` (bounded, single-flight) first, and return `cost` +
  `contextWindow` so rate cards reach the board.
- **`detectModel` shape**: returns a bare id while `refreshModels` returns `provider/id`;
  reconcile, and stop persisting a throwaway session on every probe.
- **Work products on non-issue wakes** 404 warn-only (chat wakes carry `taskId: "chat-1"`);
  POSTs are also unbounded network waits on the run path. Gate on a real issue id and bound
  the call.
- **Cost truth** (absorbs item 6): parse omp's `pricingStatus` (`fixed|free|included|variable|
  unknown`) instead of guessing from a zero rate card; emit `costStatus`/`pricingProvenance`;
  populate `usageByModel` so failover produces per-model receipts.
- **Discovery honesty**: drop the `_omp/subagents` probe (the method does not exist; every run
  pays a wasted frame).

Acceptance: the panel renders real cost on a real run; a retired model disappears after one
refresh; no 404 work-product POSTs in a chat-wake run.

### 20. Spend that can actually stop

- Add `--max-cost` (hard stop, subagents included, print exit 3) and `--warn-cost` to the run
  overlay. The bridge's `budgetCapUsd` stays as a soft, earlier signal — it is bypassable by
  any tool that never reaches the bridge, and it is per-process, so subagents multiply it.
- Reconcile the README's rate-card table with `pricingStatus`; keep declared-free and unpriced
  visually distinct.
- Acceptance: a run with a 1¢ cap stops before the second model request; the board shows
  `costStatus` matching what the engine actually reported.

### 21. Session correctness (absorbs 9's correctness half)

- **Per-session lease.** Warm reuse is rejected by the engine, so consecutive heartbeats are
  close-and-relaunch: two overlapping runs are two processes on one session file. Add an
  adapter-owned per-`sessionKey` lease covering `execute()`.
- **Fork precondition.** `session/fork` is passed the *current* run's cwd; omp rejects the
  open when it differs from the source session's recorded cwd. Read the source cwd from the
  listing and pass that.
- **Restore cliff.** omp ≥18.6.3 fails `session/load|fork|switch` with `Could not restore
  model <id>` instead of silently switching; the adapter classifies that as a hard
  `acpx_session_init_failed` and the employee never recovers. Classify it as rotate-to-fresh.
- **Context pressure.** Consume `usage_update` (`size`/`used`/`cost`) instead of estimating
  cost from rate cards; it is the only place omp reports the compaction signal.
- Acceptance: kill one of two concurrent runs mid-turn — the survivor completes; a removed
  model degrades to a fresh session instead of a dead employee.

### 22. Governance integrity (the item 4 decision, plus the fence that survives yolo)

- **Fail closed on a missing bridge.** Today `armed` means "manifest path set and dist path
  has no whitespace", never "the extension loaded". A failed load is logged and the run
  continues with `approvalMode: yolo` and no gate. If a policy was expected, refuse the run.
- **`tools.restrictedFolders`** for `.git`, secret stores and sibling tenants' worktrees —
  the only fence that asks in every approval mode, `yolo` included.
- **Single-gate reality check**: a settings-level `yolo` is coerced to `always-ask` for the
  four gated tools, so bash/edit/delete/move still reach the engine proxy. Document it, and
  reject `deny-all` combined with a governed bash allow (it rejects the call outright).
- **Do not enable plan mode** until an elicitation client exists on one side or the other.
  This is a deliberate "no", not a pending feature.
- Acceptance: an unloadable bridge fails the run loudly; a write to a restricted folder asks
  even under yolo; plan mode cannot be switched on by config.

### 23. Upgrade contract

- Pin a tested omp range in `peerDependencies` and enforce the **minor** in
  `testEnvironment` (today any `x.y.z` parses as fine).
- Pin `@paperclipai/adapter-utils` to a tested calver rather than a caret across ~30 weekly
  releases that carry the engine behavior this adapter compensates for.
- Tolerate a missing `schemaVersion` in `omp models --json`; parse by field, not position.
- Known cliffs to encode as tests: `ui.approve()` shape change, OTLP `pi.*`→`omp.*`
  attributes, `session/set_config_option` accepting only `mode|model|thinking`.
- Acceptance: a simulated 18.x minor bump with a renamed config key fails `testEnvironment`
  with a readable message instead of failing a heartbeat.

---

## P1 — v0.10 "Model control & failover" — **shipped in 0.10.0 (2026-10-30)**

Items 2, 10 and the paging half of 9 shipped (release notes and limits in `CHANGELOG.md`). Items 3,
7b, 24 and 25 were re-scoped out of this release after the evidence review; each now sits in
**Parked** with the missing upstream lever named.

### 2. Thinking and model control without rotation
Move `--thinking` into a `--config` overlay (`defaultThinkingLevel`), add live
`session/set_config_option {configId:"thinking"}` after handshake, and switch models via
`set_config_option {configId:"model"}` instead of re-invoking a run. Stop rotating the
Paperclip fingerprint when only the thinking level changes (prompt-cache loss today).

### 10. Failover that survives quota
Write `retry.fallbackOn: usage-limit`, `retry.waitForUsageReset`, `retry.fallbackRevertPolicy`,
and per-role chains — `default` never applies to model-kind roles. Report which model served
the turn (needs item 19's `usageByModel`).

### 3. MCP, second half — **parked (upstream)**
Managed company gateways need an adapter-declarable allowlist upstream (today hardcoded to
`codex_local`); stdio servers need a command discriminator on `AdapterRuntimeMcpServer`.
Per-server allow/deny and failure surfacing stay adapter-side.

### 9. Sessions — paging shipped; compaction half blocked
ACP `session/list` now pages through cursors up to a cap and reports truncation honestly (0.10.0).
Compaction alignment stays out: the engine does not expose context pressure to the adapter, so
adapter-owned rotation remains the only lever.

### 7b. Credential grants per employee — **parked (operator-side)**
`auth-gateway serve --clients` (model allowlist + broker account per client) is real, but the
gateway has no dedicated env contract: the child inherits `OMP_AUTH_BROKER_*` and provider base
URLs are configured, not injected. Nothing adapter-local to build; it belongs in the operator guide.

### 24. Cold-start economics — **parked (needs an engine seam)**
`omp --restore`, `-p --wait-async`, `session pack|unpack` are CLI-launch features; this adapter
drives `omp acp`, and the engine exposes no launch-flag passthrough for them. Revisit when the
engine can carry a maintenance or restore mode.

### 25. Sandbox / remote execution — **blocked upstream**
Two hardcoded sets exclude `omp_local`: `REMOTE_MANAGED_ADAPTERS` (local only) and the Rust
runner's closed ACPX profile list. Until one opens, omp employees cannot be sandboxed or run
remotely; any fleet plan that assumes a sandbox boundary is fiction.

---

## P2 — "Org runtime" (v0.13+; no v1.0 cut)

### 12. The RPC lane — **v0.12 run lane, v0.13 subagent surface**
One employee, one run transport. `omp --mode rpc` becomes the run lane (warm worker per
`(company, agent, cwd, sessionKey)`); ACP stays the probe lane for `session/list`, `_omp/*`,
`session/fork` and model discovery.

- **12a executor** — the supervisor spawns the worker and maps frames onto `ctx.onEvent`/`onLog`/
  `onUsage`; settlement is the worker's `prompt_result.sessionSettled` / `session_settled`, never a
  timeout.
- **12b subagents** — `set_subagent_subscription` (`off|progress|events`), `get_subagents`,
  `get_subagent_messages` (byte-incremental), `cancel_subagent`, `steer_subagent`.
- **12c host tools** — `set_host_tools` / `set_host_uri_schemes`: the supervisor answers
  `host_tool_call` frames as the MCP client behind Paperclip's connection tools, so the bearer never
  enters the worker.

Acceptance: an employee's heartbeat shows a subagent tree with per-subagent transcripts and cost, and
can cancel one without stopping the parent turn.

### 26. Live steering — **unblocked on the RPC lane (v0.12, default off)**
`steer` / `follow_up` reach a running turn on the worker; gated behind `steering: "on"` until
Paperclip has a UI contract. The ACP `_session/steering` extension stays unused.

### 5 / 13 — done
Skills-as-tools and the extension bridge shipped in v0.7/v0.8. Nothing to build; keep them
covered by tests.

---

## Parked (with the reason, so nobody re-proposes them)

| Item | Why parked | What would unpark it |
|---|---|---|
| 4 plan-mode governance | Plan approval is auto-granted without an `elicitation/form` client; extension plan-review hooks are TUI-only | A paperclip elicitation client on the ACP lane, or omp emitting `plan_review_requested` in ACP mode |
| 8 warm process pool | Host-lane reuse is discarded while a live run-scoped credential exists | An upstream credential-rebind protocol |
| 11 OTLP export | Paperclip's launch builder is hardcoded to claude/codex; other harnesses resolve `unsupported_harness` | A harness-agnostic observability launcher |
| 14 headless collab | `CollabHost` depends on the TUI context; `omp join` refuses non-TTY | Upstream extraction of a headless host |
| 15 omp worktrees | Paperclip already owns `git_worktree` per run | Nothing — this is the correct division |
| 16 in-process SDK | Bun-only public surface | Not expected; the process boundary (ACP + RPC) is sufficient |
| 3 MCP second half | Managed-gateway allowlist hardcoded to `codex_local`; `AdapterRuntimeMcpServer` has no stdio/command discriminator | An adapter-declarable managed-MCP allowlist and a stdio server shape upstream |
| 7b gateway client grants | No dedicated env contract for the gateway; provider base URLs are operator config | An upstream gateway URL/token contract the adapter can inject |
| 24 cold-start economics | `--restore` / `-p --wait-async` / `session pack` are CLI-launch flags; the engine exposes no passthrough | A launch-flag seam in the ACPX engine |
| 25 sandbox / remote | `REMOTE_MANAGED_ADAPTERS` is local-only and the runner's ACPX profiles are closed | An allowlist change that admits external adapters |

---

## Upstream contributions (Paperclip) — status verified 2026-10-26

| Item | Status | Unlocks |
|---|---|---|
| `supportsAcp`-style capability for engine-backed externals | **done** (`Boolean(adapter.acp)`) | Close this ask |
| Custom-lane control-key forwarding | **half done** — `model` forwarded, thinking key is still `effort` | Item 2 without omp-side changes |
| Per-agent config on `refreshModels`/`detectModel` | **absent** (still zero-arg) | Discovery honors `command` overrides |
| ACP elicitation client on the legacy lane | **absent** | Unparks item 4; makes plan mode meaningful |
| Steering path for `_session/steering` | **absent** | Item 26 |
| `session/fork` / `session/set_mode` in the ACPX engine | **absent** | Item 21 without shelling out |
| stdio MCP servers in `AdapterRuntimeMcpServer` | **absent** (url+token only) | Item 3 second half |
| Adapter-declarable managed-MCP allowlist | **absent** (hardcoded `codex_local`) | Item 3 second half |
| Remote/sandbox allowlist that accepts external adapters | **absent** | Item 25 |
| Mobile/web-worker fallback in the sandboxed parser | **absent** | Rendered transcripts on every device |
| Type + document `paperclipRuntimeTools` / `runtimeToolDelivery` | **absent** | Item 17 stops guessing |

## Upstream requests (oh-my-pi) — status verified 2026-10-26

| Item | Status | Why |
|---|---|---|
| `_omp/models/refresh` over ACP | **absent** — workaround is `omp models refresh` from `refreshModels` | Item 19 |
| `_omp/subagents` over ACP | **will not happen** — drop the ask, use RPC | Item 12 |
| Headless collab host | **partial** — registry/CLI already run outside the TUI; only hosting itself is gated | Item 14 |
| Runtime-neutral SDK | **moot** — Go/Python/Rust RPC clients exist at the process boundary | Item 16 |
| Stable, versioned model-list schema | **partial** — fields documented, envelope unversioned | Item 19 |
| ACP plan-review hook outside the TUI | **absent** | Unparks item 4 cheaply |

---

## Completed

*Historical entries are preserved as written. Where an entry states a blocker that the
2026-10-30 assessment resolved (for example the "resume fingerprint instability"), the
assessment above supersedes it.*

- **2026-11-02 — v0.16.0 → v0.19.0 (Operator surface, naming/cost, conformance, live smoke).**
  v0.16: `omp-host stats`, `resultJson.hostRuntime` + plugin render, lifecycle docs and an optional
  systemd user unit, socket permission/owner self-check. v0.17: `omp.tool_call` replaces
  `acpx.tool_call` (one-version alias), the acpx stdout parser retired behind `./ui-parser`, per-run
  cost deltas with an honest cumulative fallback. v0.18: five supervisor invariant scenarios
  (lease overlap, capacity, reconciliation, run-lease kill, capability-less worker) and
  `sessionScope: "isolated"` by default under broker credentials. v0.19: `npm run smoke:real` against a
  real omp (two turns, one reused worker, per-run usage, ledger settlement) and `LIVE-CHECK.md` for the
  Paperclip-instance half.

- **2026-10-31 — v0.15.0 (Single lane).** Engine run path deleted: `adapters/acp/engine.ts`, the engine
  branch of the run plan, `buildOmpAcpConfig`/`DEFAULT_ACP_ENGINE_*`, `executionMode`, the adapter-side
  lease wrapper and `retry.ts` (engine error taxonomy). The supervisor is the only run path; ACP remains
  the probe lane. −2,553 lines, 754 unit tests, 3 conformance tests on one lane, 60 s warm test green.

- **2026-10-30 — v0.14.0 (Pin bump, probes, conformance).** `adapter-utils` 2026.1023.0; the
  `runtimeToolDelivery` and `RunCostFields` shims deleted; `errorFamily`/`retryNotBefore` first in retry
  classification; warm-handle value passed through (the settlement gate still discards credential-carrying
  saves — pinned by `warm-handle-settlement.test.ts`); capability probes replace the minor gate with
  named warnings and major-only errors, RPC probes scoped to managed mode; a conformance project drives
  both lanes against fixtures in CI; the engine codec/bundle boundary moved under `adapters/acp/`;
  `dist/omp-host.js` externalizes the dependency (110 KB). 813 tests + 9 conformance + the 60 s warm test.

- **2026-10-30 — v0.13.0 (Subagent observability).** `subagentObservability` (`off|summary|events`,
  default `summary`, typed refusal for typos) maps to omp's RPC subscription, is re-sent per run so a
  warm worker cannot inherit a level, streams bounded `omp.subagent` events and writes a capped
  `resultJson.subagents` snapshot scoped to the run's own observations. Redaction proven by a fixture
  carrying a real JWT. 776 tests + the opt-in 60 s warm test (36/36).

- **2026-10-30 — v0.12.0 (Managed lane).** Per-instance `omp-host` supervisor (Unix-socket JSONL v1,
  ledger, run lease, capacity, reconciliation, CLI + `dist/omp-host.js`), RPC run worker with warm reuse
  per `(company, agent, cwd, sessionKey)`, run JWT moved to a 0600 run-context file and stripped from the
  worker env, connection tools answered by the supervisor as an MCP client, steering behind a flag.
  `executionMode: "engine"` stays the default and the rollback. 745 tests + an opt-in 60 s warm test;
  `kill -9` leaves no orphan and one `lost/host_exit`.

- **2026-10-30 — v0.11.0 (Seams).** Four behaviour-preserving cuts: ACP client extracted
  (`adapters/acp/client.ts`, cycle gone), side-channel port, one overlay writer, executor split into
  `buildRunPlan` + `executePlan` (`acp.ts` 1,311 → 112 lines). Same exports, events and error codes;
  655 tests before and after. Unblocks the RPC lane as a new `adapters/rpc/` directory.

- **2026-10-30 — v0.10.1 (omp 18.14 compatibility).** Tested set is now 18.13.x + 18.14.x with peer
  `<18.15.0`; provider-qualified model/fallback selectors are resolved against the catalog and refused
  when unresolved (omp 18.14 resolves them exactly); bare selectors keep fuzzy matching. 655 tests.

- **2026-10-30 — v0.10.0 (Model control & failover).** Thinking level moved into a settings overlay
  (no fingerprint rotation) with a one-time rotation when it changes on an existing session and a
  fork-aware record of what each session started with; validated `fallbackOn`,
  `fallbackRevertPolicy`, `waitForUsageReset` and `maxDelayMs` in the retry overlay; honest cursor
  paging for the session snapshot (623 tests). Items 3, 7b, 24 and 25 re-scoped into Parked with the
  missing upstream lever named; v1.0 remains out of scope.

- **2026-10-30 — v0.9.0 (Correctness & containment).** Items 17–23 shipped in four sequential lanes
  (26 commits, 588 tests): run identity (`supportsLocalAgentJwt`, `native_mcp` delivery, instructions
  bundle) with the warm-handle pin; the session fence (`sessionScope`, cwd-scoped ACP `session/list`,
  counts-only diagnostic); the repair pass (plugin SQL, catalog refresh, read-only `detectModel`,
  bounded work-product POSTs, dead `_omp/subagents` probe removed); cost truth from `pricingStatus`
  plus `session.maxCost`/`warnCost`; the per-session lease, fork cwd and restore-model classifier;
  governance fail-closed on a missing bridge artifact with bridge-enforced `restrictedFolders`; and
  the upgrade contract (tested omp minor enforced, `adapter-utils` pinned). Limits in `CHANGELOG.md`.

- **2026-09-03 — v0.8.0 (Governance & control).** Guardrail `tool_call` engine (path/bash/deny/revise,
  control-tool-allowlist, mtime re-read) via the paperclip bridge as the sole deny point
  (`approvalMode:yolo` overlay single-gate); soft per-session cost budget (`message_end`); endpoint
  allow-listing via a side-channel-isolated `disabledProviders` governance overlay (live-verified on
  18.1.6); advisory human-approval round-trip (fail-closed, deduped, no auto-resume pending the resume
  fix); session panel per-run model; subagent-observability upstream ask + gated stub. Adapter-local
  except the two honestly-deferred items.


- **2026-09-01 — v0.7.0 (Native integration).** Lazy-skill bridge (`skillsAsTools` field; a static
  omp ExtensionAPI extension registers each enabled company skill as an essential on-demand tool
  returning its `SKILL.md`, replacing eager prompt-injection; manifest handoff via `config.env`;
  side-channel fail-soft; provider-safe names) and the `paperclip-plugin-omp-session` package (agent
  `detailTab` reading `heartbeat_runs`/`cost_events` via the plugin worker). Both adapter-local, no
  upstream required. Remaining G3: warm process pool (item 8), fork/compaction un-gating (blocked on
  the cross-run resume fingerprint instability), rich per-session metadata (upstream `_omp` fields),
  and the full cross-session omp browser (issue-scoped work products).


- **2026-08-31 — v0.6.0 (Fleet control).** Thinking directive (`--thinking` on `agentCommand`,
  rotate-on-change; effort-key strip extended to all four engine keys; `indexOf("acp")` token-split
  for catalog/version/broker probes) and worktree side-channel cwd alignment (mirror the engine's
  `paperclipWorkspace.cwd` precedence). Adapter-local, no upstream dependency. Item 2 (thinking/model
  controls) shipped as next-run directives; model path confirmed live. Descoped after research:
  gateway metering proxy (redundant with v0.5 broker + usage work products), cost-per-heartbeat board
  field (`getConfigSchema` context-free), `mode` knob (no engine seam). Remaining: plugin-SDK session
  panel + ExtensionAPI bridge (v0.7), warm process pool (item 8), fork/compaction un-gating (blocked
  on the cross-run resume fingerprint instability).


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
