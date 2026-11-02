# omp-paperclip-adapter — Roadmap

**Vision:** make oh-my-pi a first-class *organizational runtime* on Paperclip — not a wrapped
CLI, but an employee population with shared credentials, subagent teams, governance-gated
planning, cost intelligence, and session continuity that survives restarts, models, and
machines.

**Shape of the integration.** One employee, one run lane:

- **Managed lane (default)** — the per-instance `omp-host` supervisor drives `omp --mode rpc`:
  warm workers, host tools, explicit settlement, steering, subagent observability, and the run
  ledger. Shipped from 0.12.0; the pre-0.15 engine lane is deleted.
- **Probe lane** — `omp acp` for `session/list`, `session/fork`, `_omp/*`, model discovery and
  the environment probe. It never carries a run.

Priority order: correctness → containment → spend truth → fleet → org runtime. Release history
lives in [CHANGELOG.md](CHANGELOG.md); this file tracks open work and what is deliberately parked.

## Current adapter-local work

No open adapter-local feature work. The remaining improvements need an upstream seam or an
operator-side capability; they are listed below with the lever that would unpark them.
Release/publication chores (CI, packaging, docs) are tracked outside this roadmap.

## Parked (with the reason, so nobody re-proposes them)

| Item | Why parked | What would unpark it |
|---|---|---|
| Plan-mode governance | Plan approval is auto-granted without an `elicitation/form` client; extension plan-review hooks are TUI-only | A Paperclip elicitation client on the ACP lane, or omp emitting `plan_review_requested` in ACP mode |
| Warm process pool | Host-lane reuse is discarded while a live run-scoped credential exists | An upstream credential-rebind protocol |
| OTLP export | Paperclip's launch builder is hardcoded to claude/codex; other harnesses resolve `unsupported_harness` | A harness-agnostic observability launcher |
| Headless collab | `CollabHost` depends on the TUI context; `omp join` refuses non-TTY | Upstream extraction of a headless host |
| omp worktrees | Paperclip already owns `git_worktree` per run | Nothing — this is the correct division |
| In-process SDK | Bun-only public surface | Not expected; the process boundary (ACP + RPC) is sufficient |
| MCP second half | Managed-gateway allowlist hardcoded to `codex_local`; `AdapterRuntimeMcpServer` has no stdio/command discriminator | An adapter-declarable managed-MCP allowlist and a stdio server shape upstream |
| Gateway client grants | No dedicated env contract for the gateway; provider base URLs are operator config | An upstream gateway URL/token contract the adapter can inject |
| Cold-start economics | `--restore` / `-p --wait-async` / `session pack` are CLI-launch flags; the engine exposes no passthrough | A launch-flag seam in the ACPX engine |
| Sandbox / remote execution | `REMOTE_MANAGED_ADAPTERS` is local-only and the runner's ACPX profiles are closed | An allowlist change that admits external adapters |
| Context-pressure compaction | The engine does not expose context pressure to the adapter | An engine signal; adapter-owned rotation is the current lever |
| Per-subagent cancel/steer | The board contract for a subagent control surface does not exist | A Paperclip control contract; cancelling the run already kills the worker group |

## Upstream contributions (Paperclip) — status verified 2026-10-26

| Item | Status | Unlocks |
|---|---|---|
| `supportsAcp`-style capability for engine-backed externals | **done** (`Boolean(adapter.acp)`) | Close this ask |
| Custom-lane control-key forwarding | **half done** — `model` forwarded, thinking key is still `effort` | Thinking control without omp-side changes |
| Per-agent config on `refreshModels`/`detectModel` | **absent** (still zero-arg) | Discovery honors `command` overrides |
| ACP elicitation client on the legacy lane | **absent** | Unparks plan mode |
| Steering path for `_session/steering` | **absent** | ACP-side stepping (the RPC lane already steers) |
| `session/fork` / `session/set_mode` in the ACPX engine | **absent** | Fork without shelling out |
| stdio MCP servers in `AdapterRuntimeMcpServer` | **absent** (url+token only) | MCP second half |
| Adapter-declarable managed-MCP allowlist | **absent** (hardcoded `codex_local`) | MCP second half |
| Remote/sandbox allowlist that accepts external adapters | **absent** | Sandbox / remote execution |
| Mobile/web-worker fallback in the sandboxed parser | **absent** | Rendered transcripts on every device |
| Type + document `paperclipRuntimeTools` / `runtimeToolDelivery` | **absent** | Stop guessing the delivery contract |

## Upstream requests (oh-my-pi) — status verified 2026-10-26

| Item | Status | Why |
|---|---|---|
| `_omp/models/refresh` over ACP | **absent** — workaround is `omp models refresh` from `refreshModels` | Catalog refresh |
| `_omp/subagents` over ACP | **will not happen** — drop the ask, use RPC | Subagent surface |
| Headless collab host | **partial** — registry/CLI already run outside the TUI; only hosting itself is gated | Headless collaboration |
| Runtime-neutral SDK | **moot** — Go/Python/Rust RPC clients exist at the process boundary | Embedding |
| Stable, versioned model-list schema | **partial** — fields documented, envelope unversioned | Discovery robustness |
| ACP plan-review hook outside the TUI | **absent** | Unparks plan mode cheaply |

## Non-negotiables

- One run path (the supervisor); rollback means reinstalling the previous release, not flipping
  a config key.
- The bridge stays one self-contained bundle.
- No credential ever enters a warm worker's environment.
