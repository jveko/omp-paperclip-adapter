# omp-paperclip-adapter

A [Paperclip](https://github.com/paperclipai/paperclip) external adapter that runs
[oh-my-pi](https://github.com/can1357/oh-my-pi) (`omp`) as managed agent employees —
registered as adapter type `omp_local`, executed through Paperclip's ACPX engine over the
Agent Client Protocol.

## How it works

```
Paperclip heartbeat ──▶ omp_local adapter ──▶ ACPX engine (custom lane)
                                              └─ spawns `omp acp` (ACP v1 over stdio)
                                                  ├─ session/new · resume · fork
                                                  ├─ tool calls ⇄ Paperclip permissions
                                                  └─ usage_update ──▶ cost attribution
```

One execution lane (ACP), zero Paperclip source modifications. Model discovery shells out to
`omp models ls --json` (live registry incl. custom providers, with rate cards).

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
| `warmHandleIdleMs` | `0` | > 0 keeps a warm ACP process between heartbeats |
| `timeoutSec` / `graceSec` | `0` / `20` | run timeout / SIGTERM grace |
| `stateDir`, `instructionsFilePath`, `cwd`, `env` | unset | passed through to the engine |

Permissions are owned by these engine knobs — the adapter never passes `--auto-approve`.

## Development

```sh
npm install
npm test          # vitest unit suite (25 tests)
npm run build     # tsc + self-contained ui-parser bundle
npm run typecheck
```

See `ROADMAP.md` for where this is heading.

## License

MIT
