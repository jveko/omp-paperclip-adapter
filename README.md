# omp-paperclip-adapter

A [Paperclip](https://github.com/paperclipai/paperclip) external adapter that runs
[oh-my-pi](https://github.com/can1357/oh-my-pi) (`omp`) as managed agent employees —
registered as adapter type `omp_local`, executed by the per-instance `omp-host`
supervisor, which drives an `omp --mode rpc` worker over the run ledger.

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

- oh-my-pi CLI ≥ 18.x (`omp` on PATH, or an absolute path via config)
- Node.js ≥ 24.11 (runs inside the Paperclip server process)
- A Paperclip instance with external-adapter installs enabled

## Install

Board UI → Settings → Adapters → Install from local path:

```
/home/<you>/workspace/projects/omp-paperclip-adapter
```

or via API (instance-admin):

```sh
curl -X POST http://<host>:3100/api/adapters/install \
  -H "Authorization: Bearer <board-key>" -H "Content-Type: application/json" \
  -d '{"packageName": "/path/to/omp-paperclip-adapter", "isLocalPath": true}'
```

Hot-registers — no service restart needed (`requiresRestart` only on reinstall).

## Configuration

| Field | Default | Notes |
|---|---|---|
| `command` | `"omp"` | binary name/path; prefer absolute if the service PATH strips version-manager shims |
| `agentCommand` | `<command> acp` | explicit override wins |
| `model` | *(omp default)* | any fuzzy pattern (`provider/id`); resolved by omp |
| `mode` | `persistent` | `persistent` \| `oneshot` |
| `permissionMode` | `approve-all` | `approve-reads` / `deny-all` to tighten |
| `nonInteractivePermissions` | `deny` | fail-closed headless turns |
| `timeoutSec` / `graceSec` | `0` / `15` | run timeout / SIGTERM grace (the adapter forwards an explicit value) |
| `stateDir`, `instructionsFilePath`, `cwd`, `env` | unset | passed through to the run child |
| `sessionScope` | `"shared"` | `shared` = omp's host agent dir (every employee on the host shares sessions). `isolated` requires `credentialMode: broker`, fences the agent dir per employee, and fails fast otherwise |
| `subagentObservability` | `"summary"` | `off` / `summary` / `events`. Streams bounded `omp.subagent` events and a `resultJson.subagents` snapshot |
| `thinking` | *(omp default)* | `off`, `auto`, `minimal`…`max`; applied through a settings overlay. Changing it on an existing session costs one rotation (omp keeps a resumed transcript's stored level) |
| `fallbackChain` | unset | per-agent model fallback chain (`retry.fallbackChains.default`) |
| `fallbackOn` / `fallbackRevertPolicy` / `waitForUsageReset` / `maxDelayMs` | `any` / `cooldown-expiry` / `false` / unset | failover trigger, revert policy, authorize long usage-reset waits, backoff ceiling |

Permissions are owned by these omp knobs — the adapter never passes `--auto-approve`.

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

Unknown values fall back to `"api"`; the environment check flags unknown `OMP_PAPERCLIP_BILLING_TYPE` values.

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
authentication a single-user host needs.

To keep one supervisor up across reboots, `contrib/systemd/omp-host.service` is
a copy-paste `systemd --user` unit; adjust its `ExecStart` to this checkout's
`dist/omp-host.js`. It is optional: the adapter starts (and idles out) the host
by itself, so the unit only helps when you want it pinned.

## Development

```sh
npm install
npm test          # vitest unit suite
npm run build     # tsc + self-contained ui-parser bundle
npm run typecheck
```

See `ROADMAP.md` for where this is heading.

## License

MIT
