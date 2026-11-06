# omp-paperclip-adapter

[![CI](https://github.com/jveko/omp-paperclip-adapter/actions/workflows/ci.yml/badge.svg)](https://github.com/jveko/omp-paperclip-adapter/actions/workflows/ci.yml)

A [Paperclip](https://github.com/paperclipai/paperclip) external adapter that runs
[oh-my-pi](https://github.com/can1357/oh-my-pi) (`omp`) as managed agent employees —
registered as adapter type `omp_local`, executed by the per-instance `omp-host`
supervisor, which drives an `omp --mode rpc` worker over the run ledger.

Pre-1.0: the configuration surface and the supervisor protocol can still change
between minor releases. See [CHANGELOG.md](CHANGELOG.md) for behaviour changes,
[ROADMAP.md](ROADMAP.md) for open and parked work, and [SECURITY.md](SECURITY.md)
for the trust model and reporting.

## How it works

```
Paperclip heartbeat ──▶ omp_local adapter ──▶ omp-host supervisor (unix socket)
                                              └─ spawns `omp --mode rpc` (JSONL over stdio)
                                                  ├─ session open · resume · fork
                                                  ├─ tool calls ⇄ Paperclip host tools
                                                  └─ worker stats ──▶ cost attribution
```

One execution lane, zero Paperclip source modifications. The Agent Client Protocol remains
the probe lane only (`session/list`, `_omp/*`, `session/fork`, model discovery, the
environment probe). Model discovery shells out to `omp models ls --json` (live registry incl.
custom providers, with rate cards).

## Requirements

- Linux or macOS. The supervisor uses Unix sockets, `sh -lc`, and POSIX permissions;
  Windows is not supported.
- Node.js ≥ 24.11 (the adapter runs inside the Paperclip server process).
- oh-my-pi CLI **18.13.x or 18.14.x** (`omp` on PATH, or an absolute path via config).
  Newer 18.x minors are unverified: `testEnvironment` warns and names the probed surfaces,
  and only a different major is a hard error. `peerDependencies` pins the tested range.
- A Paperclip instance with external-adapter installs enabled (instance admin required).

## Install

Published on npm as `omp-paperclip-adapter`:

```sh
npm install omp-paperclip-adapter
```

Install it into the board from the package name. With an instance-admin credential:

```sh
curl -X POST http://<host>:3100/api/adapters/install \
  -H "Authorization: Bearer <board-key>" -H "Content-Type: application/json" \
  -d '{"packageName": "omp-paperclip-adapter"}'
```

To install local changes instead, build a checkout and pass it as a local path:

```sh
git clone https://github.com/jveko/omp-paperclip-adapter.git
cd omp-paperclip-adapter
npm ci
npm run build
curl -X POST http://<host>:3100/api/adapters/install \
  -H "Authorization: Bearer <board-key>" -H "Content-Type: application/json" \
  -d '{"packageName": "'"$PWD"'", "isLocalPath": true}'
```

Hot-registers — no service restart needed (`requiresRestart` only on reinstall). Installing
the adapter does not put `omp-host` on PATH; run `npx omp-host status` from the install, or
`npm link` a checkout.

## Configuration

The board renders the adapter's full schema. The common fields:

| Field | Default | Notes |
|---|---|---|
| `command` | `"omp"` | binary name/path; prefer absolute if the service PATH strips version-manager shims |
| `agentCommand` | `<command> acp` | explicit override wins; the supervisor strips `acp` and appends `--mode rpc` |
| `model` | *(omp default)* | any fuzzy pattern (`provider/id`); resolved by omp |
| `permissionMode` | `approve-all` | `approve-reads` / `deny-all` to tighten |
| `timeoutSec` | `0` | run deadline; `0` = unlimited. Cancellation grace is the supervisor's 5 s (`OMP_HOST_CANCEL_GRACE_MS`) |
| `env` | `{}` | includes `OMP_PAPERCLIP_BILLING_TYPE` (`api` or `subscription`) |
| `instructionsFilePath`, `cwd` | unset | passed through to the run child |
| `credentialMode` | `local` | `broker` requires `OMP_AUTH_BROKER_URL` / `OMP_AUTH_BROKER_TOKEN` via `secret_ref` |
| `sessionScope` | broker: `isolated`; otherwise `shared` | `isolated` = this agent's own omp agent dir (per employee, requires `credentialMode: broker`). `shared` = omp's host agent dir, where every employee on the host shares sessions — an explicit `shared` under broker credentials warns about that cross-tenant reach |
| `sessionBrowser` | `true` | emit a session-snapshot work product when the landscape changes |
| `sessionSnapshotDiagnostic` | `false` | log counts from omp's host-wide `_omp/*` listing (never ids, cwds or titles) |
| `sessionForkSourceId` / `sessionForkToken` / `sessionForceFreshToken` | unset | fork or reset the next session |
| `sessionMaxRuns` / `sessionMaxAgeHours` | `0` | rotate the session after N runs / N hours (`0` disables) |
| `subagentObservability` | `"summary"` | `off` / `summary` / `events`. Streams bounded `omp.subagent` events and a `resultJson.subagents` snapshot |
| `thinking` | *(omp default)* | `off`, `auto`, `minimal`…`max`; applied through a settings overlay. Changing it on an existing session costs one rotation (omp keeps a resumed transcript's stored level) |
| `fallbackChain` | unset | per-agent model fallback chain (`retry.fallbackChains.default`) |
| `fallbackOn` / `fallbackRevertPolicy` / `waitForUsageReset` / `maxDelayMs` | `any` / `cooldown-expiry` / `false` / unset | failover trigger, revert policy, authorize long usage-reset waits, backoff ceiling |
| `usageReport` | `true` | emit an `omp-usage` work product with cost estimates |
| `skillsAsTools` | `false` | expose each enabled company skill as an on-demand omp tool instead of prompt text |
| `steering` | `off` | forward steer/follow-up requests to the live turn |
| `governancePolicy` | unset | YAML/JSON guardrails, approval gates and `budgetCapUsd` enforced through the bridge |

Permissions are owned by `permissionMode` — the adapter never passes `--auto-approve`.
Legacy ACP-lane keys (`mode`, `stateDir`, `nonInteractivePermissions`, `graceSec`) are
accepted but ignored by the supervisor lane; use `timeoutSec` for a run deadline.

## Cost transparency

Cost originates from the model's rate card (`omp models ls --json`), parsed into
`OmpModelInfo.cost` (**USD per 1M tokens**: input, output, cacheRead, cacheWrite).
The supervisor accumulates cost from the worker's run stats; the adapter maps
omp's own `pricingStatus` onto the receipt instead of guessing from a zero card:

| omp `pricingStatus` | `costStatus` | `pricingProvenance` |
|---|---|---|
| `fixed`, `variable` | `estimated` | `rate_card` |
| `free` | `estimated` (zero card) | `rate_card` |
| `included` | `reported` (zero; operator's `billingType` stands) | `operator` |
| `unknown` | `unpriced` | `unknown` |

`usageByModel` carries one entry only when the run used a single model; with a
fallback chain configured, the aggregate is reported without a per-model receipt
and the run says why. `budgetCapUsd` in `governancePolicy` is forwarded to omp as
`session.maxCost` (hard stop) plus an adapter-derived `session.warnCost` at 80%.

**Billing identity** is reported as `billingType: "api"` by default. Override
per agent via `OMP_PAPERCLIP_BILLING_TYPE` in the `env` map:

```env
OMP_PAPERCLIP_BILLING_TYPE=subscription   # only "api" | "subscription" valid
```

Unknown values fall back to `"api"`; the environment check flags unknown
`OMP_PAPERCLIP_BILLING_TYPE` values.

## Running the supervisor

The adapter starts `omp-host` lazily on the first run that reaches execution and
the supervisor exits by itself after 30 minutes with no workers, runs or
connections (`OMP_HOST_IDLE_MS`; workers retire after 20 minutes warm,
`OMP_HOST_WORKER_IDLE_MS`). Nothing is installed or enabled system-wide, and
nothing survives a reboot unless you run it under your own service manager.

```sh
omp-host serve        # foreground; what the adapter spawns for you
omp-host status       # pid, epoch, worker count, and the socket permission check
omp-host stats        # runs, states, causes, settle latency, worker reuse
omp-host stats --json --since 24h
omp-host ledger tail 50
omp-host stop         # drains in-flight runs, then exits
omp-host gc           # after a crash: reap orphans, stale sockets, context files
```

State lives in `$PAPERCLIP_HOME/instances/$PAPERCLIP_INSTANCE_ID/omp-host`
(default `~/.paperclip/instances/default/omp-host`): `host.json` (discovery,
0600), `host-<token>.sock` (0600), `ledger.jsonl` (0600) and the directory
itself (0700). The socket name carries a random token, so only a process that
can read the directory can even learn it — the same-uid boundary is the only
authentication a single-user host needs. Both `serve` and every connect stat the
socket and its directory and refuse (by name) a mode wider than 0600/0700 or an
owner other than the current uid, so the boundary is checked, not assumed;
`omp-host status` prints the passing check.

To keep one supervisor up across reboots, `contrib/systemd/omp-host.service` is
a copy-paste `systemd --user` unit; adjust its `ExecStart` to this checkout's
`dist/omp-host.js`. It is optional: the adapter starts (and idles out) the host
by itself, so the unit only helps when you want it pinned.

## Session panel plugin (optional)

`paperclip-plugin-omp-session/` is a separate Paperclip plugin that adds an agent
detail tab showing recent runs' session runtime, usage and cost from
`heartbeat_runs` and `cost_events`. It is published as `paperclip-plugin-omp-session`
and is a workspace member, so `npm ci` at the repository root installs its build
dependencies.

```sh
curl -X POST http://<host>:3100/api/plugins/install \
  -H "Authorization: Bearer <board-key>" -H "Content-Type: application/json" \
  -d '{"packageName": "paperclip-plugin-omp-session"}'
```

To install local changes, run `npm run build:plugin` and pass
`'{"packageName": "'"$PWD"'/paperclip-plugin-omp-session", "isLocalPath": true}'` instead.

## Verification

```sh
npm run verify          # typecheck + unit + plugin + conformance + both builds
npm run test:conformance
npm run smoke:real      # two turns against a real omp; costs real tokens
```

`test` and `test:conformance` never reach a model: every managed path runs against a
scripted `omp`. `npm run smoke:real` is the exception — it starts the built supervisor
(`dist/omp-host.js`, rebuilt by the suite's global setup) and drives a real `omp --mode rpc`
worker through two turns on one session key, asserting accepted/settled frames, token and
cost reporting, the settled ledger record, and warm-worker reuse. It requires an
authenticated `omp` on the login-shell PATH (`OMP_SMOKE_COMMAND` overrides the binary).
[LIVE-CHECK.md](LIVE-CHECK.md) is the runbook for the Paperclip-instance half.

## Limitations

| Area | Status |
|---|---|
| Plan mode | unavailable: omp auto-approves the plan without an elicitation/form client, which would delete the approval step |
| Provider quota windows | not reported; `getQuotaWindows` receives no adapter config, so it could only show the host's login |
| Managed MCP gateways / stdio servers | blocked upstream (allowlist hardcoded to `codex_local`; no stdio shape) |
| Sandbox / remote execution | blocked upstream (remote allowlist and runner profiles exclude external adapters) |
| Context-pressure compaction | no engine seam; adapter-owned session rotation is the only lever |
| Per-subagent cancel/steer | not exposed; killing or timing out a run kills the worker group |
| Headless collaboration | blocked upstream (TUI-bound host) |

## Security

The run JWT lives in a 0600 run-context file, never in a warm worker's environment;
the ledger redacts credential-shaped strings and prompt arguments; the supervisor socket
is same-uid-only and permission-checked on every connect. The configured `command` /
`agentCommand` is executed through a login shell, so agent configuration is
operator-trusted. See [SECURITY.md](SECURITY.md) for the full model and how to report a
vulnerability.

## Development

```sh
npm ci
npm test                # unit suite (offline; no model calls)
npm run test:plugin     # session-panel plugin tests
npm run test:conformance
npm run typecheck
npm run build           # clean build: tsc + ui-parser + bridge + supervisor
npm run build:plugin
```

`npm run verify` runs all of the above except the real-model smoke test. See
[ROADMAP.md](ROADMAP.md) for open and parked work.

## License

MIT
