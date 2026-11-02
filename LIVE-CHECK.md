# Live check — `omp_local` against a real Paperclip instance

`npm run smoke:real` proves the supervisor ↔ omp half: the shipped supervisor
drives a real `omp --mode rpc` worker through two turns, settles on
`sessionSettled`, accounts tokens and cost, journals the settle, and reuses the
warm worker. It cannot prove Paperclip's dispatch, the run JWT, or the board's
records, so this runbook covers that half against a live instance.

Every step names the exact route or config field it checks and the value that
means it passed. Commands use `npx paperclipai` (the CLI speaks the same routes;
it also handles auth), with the route in the heading for anyone using `curl`.

Citations to Paperclip refer to
[`paperclipai/paperclip`](https://github.com/paperclipai/paperclip) at `abc270ee`,
and to this repository.

## Prerequisites

1. **Instance reachable.** Default origin `http://localhost:3100` (`server/src/config.ts:387`).
   Board credential for the CLI:

   ```sh
   export PC=http://localhost:3100
   npx paperclipai auth login --api-base $PC
   ```

   Adapter install/update routes additionally require an instance admin
   (`server/src/routes/adapters.ts:344-347`) and are refused on cloud-managed
   instances (`:71-77`).

2. **Run JWTs are mintable.** Paperclip mints the per-run JWT only when
   `PAPERCLIP_AGENT_JWT_SECRET` (or `BETTER_AUTH_SECRET`) is set on the server
   (`server/src/agent-auth-jwt.ts:40-44`) and the adapter declares
   `supportsLocalAgentJwt` (`server/src/services/heartbeat/runtime-execution.ts:249-260`).
   Without a secret, `ctx.authToken` is empty, the bridge fails closed, and no
   approval can be requested.

3. **`omp` runs under the server's login shell** and is authenticated. The
   supervisor launches `sh -lc 'exec <command> ... --mode rpc'`
   (`src/host/worker.ts:54-84`), so `omp` must resolve there, not only in your
   interactive shell:

   ```sh
   sh -lc 'exec omp --version'    # omp/18.14.0 (tested lines: 18.13.x, 18.14.x)
   sh -lc 'exec omp -p "say ok"'  # an authenticated turn
   ```

4. **The adapter is built** in this checkout: `npm ci && npm run build`.

5. **The `omp-host` CLI is reachable.** Installing the adapter into Paperclip
   does not put this package's `bin` on your PATH. Either link it once:

   ```sh
   npm link            # exposes the `omp-host` bin from package.json
   ```

   or alias the built entry point and use that name below:

   ```sh
   alias omp-host="node $PWD/dist/omp-host.js"
   ```

6. **Pick a workspace for the agent** (the probes and the agent config both use
   it, and `testEnvironment` fails with `omp_cwd_invalid` on a missing path):

   ```sh
   mkdir -p "$HOME/work/omp-live-check"
   ```

7. **Know the supervisor's directory.**

   ```sh
   export HOST_ROOT="${PAPERCLIP_HOME:-$HOME/.paperclip}/instances/${PAPERCLIP_INSTANCE_ID:-default}/omp-host"
   export COMPANY=<company-id>
   ```

## 1. Install the adapter from this path

```sh
npx paperclipai adapter install --payload-json '{"packageName":"'"$PWD"'","isLocalPath":true}'
```

Route: `POST /api/adapters/install` with `{packageName, isLocalPath: true}`
(`server/src/routes/adapters.ts:344-456`; the CLI wrapper posts the payload
verbatim, `cli/src/commands/client/adapter.ts:35,129-140`). The docs'
`POST /api/adapters` / `{localPath}` spelling in
Paperclip's `docs/adapters/external-adapters.md:283-298` is stale for this commit.

**Expected.** `201` with `{type: "omp_local", packageName: "<abs path>", version: "<this checkout's package.json version>", requiresRestart: false}`.
`requiresRestart: true` means this type was already registered (a reinstall) — restart Paperclip before continuing.

Then confirm the registration:

```sh
npx paperclipai adapter list --json | jq '.[] | select(.type == "omp_local")'
```

**Expected fields** (`GET /api/adapters`, `server/src/routes/adapters.ts:281`; field builder `buildAdapterInfo` at `:193-219`):

| Field | Expected |
|---|---|
| `type` | `omp_local` |
| `source` | `external` |
| `loaded` | `true` |
| `isLocalPath` | `true` |
| `version` | this checkout's `package.json` version (read from disk) |
| `capabilities.supportsLocalAgentJwt` | `true` |

The record also lands in `~/.paperclip/adapter-plugins.json` as
`{packageName, localPath, version, type, installedAt}`
(`server/src/services/adapter-plugin-store.ts:1-54`).

The UI parser is served from the package's `./ui-parser` export; check it if
run logs matter: `GET /api/adapters/omp_local/ui-parser.js` returns JavaScript,
not a 404.

## 2. Probe the environment (version, catalog, host, socket)

`testEnvironment` has no host or socket checks of its own; it reports the
`omp` binary, the ACP handshake, the model catalog, and session scope. The
supervisor's host and socket are checked separately below.

### 2a. `testEnvironment`

```sh
npx paperclipai adapter test-environment omp_local -C $COMPANY \
  --payload-json '{"adapterConfig":{"command":"omp","cwd":"'"$HOME/work/omp-live-check"'"}}'
```

Route: `POST /api/companies/:companyId/adapters/omp_local/test-environment`
(`server/src/routes/agents.ts:3254-3256`); response is
`{adapterType, status: "pass"|"warn"|"fail", checks[], testedAt}`
(`packages/adapter-utils/src/types.ts:303-320`). The checks come from
`src/server/test.ts:211-345`.

**Expected** `status: "pass"` (a `warn` is acceptable only for the session-scope
check below) and these `code` values:

| Check `code` | Level | Meaning |
|---|---|---|
| `omp_cwd_ok` | info | `cwd` is absolute and readable |
| `omp_command_resolvable` | info | the `command` binary resolves for the server |
| `omp_version` | info | message names `18.13.x` or `18.14.x`; `omp_version_untested_minor` is a warning, `omp_version_unsupported` is an error |
| `acp_handshake_ok` | info | `omp acp` answered `initialize` + `session/new` (hard gate; `acp_handshake_failed` is an error) |
| `omp_capabilities` | info | `n/m` probed surfaces present |
| `omp_sessions_shared` / `omp_sessions_isolated` | warn / info | the session scope this agent will run under |

### 2b. Model catalog

```sh
npx paperclipai adapter models omp_local -C $COMPANY --refresh --json | jq 'length'
```

Route: `GET /api/companies/:companyId/adapters/omp_local/models?refresh=true`
(`server/src/routes/agents.ts:3052`), which calls the adapter's `refreshModels`
(`src/server/index.ts:37-44`; hook at `:56-60`).

**Expected:** a non-zero number of `{id, label, contextWindow?, cost?}` rows —
the same ids your `omp` model registry offers. `GET /api/adapters` reporting
`modelsCount: 0` is not a failure: the adapter declares `models: []` and
refreshes lazily (`src/server/index.ts:56`).

### 2c. Supervisor and socket

The supervisor starts lazily on the first run, so before step 5 this prints
`host not running` — that is expected, not a failure. After step 5:

```sh
omp-host status
```

**Expected** (`src/host/cli.ts:149-181`):

```text
host 0.12.0 pid=<pid> epoch=<epoch> workers=1
socket 0600 owner=<uid> ok
```

The `host` number is the supervisor's own version string
(`options.version ?? "0.12.0"`, `src/host/server.ts:342`), not this package's
`version`; the adapter spawns `serve` without one.

`socket 0600 owner=<uid> ok` is the same-UID invariant checked at startup and at
every connect (`src/host/socket.ts:95-125`); a refusal here names the widened
mode or the foreign owner instead.

## 3. Hire an `omp_local` agent

```sh
npx paperclipai agent hire -C $COMPANY --payload-json '{
  "name": "Omp Live Check",
  "role": "engineer",
  "adapterType": "omp_local",
  "adapterConfig": {
    "command": "omp",
    "cwd": "'"$HOME"'/work/omp-live-check",
    "timeoutSec": 600,
    "sessionScope": "shared"
  }
}'
```

Route: `POST /api/companies/:companyId/agent-hires`
(`server/src/routes/agents.ts:4761`; the plain create route is
`POST /api/companies/:companyId/agents` at `:4767`). `adapterType` is accepted
only if the type is registered (`assertKnownAdapterType`, `server/src/routes/agents.ts:1847-1856`).

**Expected.** An agent row (or a draft plus a `hire_agent` approval when the
company requires board approval — approve it with
`npx paperclipai approval approve <id>`). Then:

```sh
export AGENT=<agent-id>
npx paperclipai agent get $AGENT --json | jq '{adapterType, adapterConfig, status, lifecycleState}'
```

**Expected:** `adapterType: "omp_local"`, `adapterConfig.command: "omp"`,
`status: "idle"`, `lifecycleState: "ready"`. Config lives in
`agents.adapter_config` (`packages/db/src/schema/agents.ts:36-39`) and is
returned redacted (`GET /api/agents/:id`, `server/src/routes/agents.ts:4171`).

Use `sessionScope: "shared"` here: the isolated scope needs broker credentials,
and this check has no Paperclip auth broker.

## 4. Create the task

Issue-scoped runs get Paperclip's project-tools MCP server with the run JWT
(`server/src/services/heartbeat/runtime-execution.ts:780-790`), which is how the
agent posts its work product.

```sh
npx paperclipai issue create -C $COMPANY \
  --title "Live check: omp_local" \
  --assignee-agent-id $AGENT \
  --description "Post your answer as a comment on this issue: the single word pong. Then mark the issue done."
export ISSUE=<issue-id>
```

**Expected:** `GET /api/issues/$ISSUE` (`npx paperclipai issue get $ISSUE`)
returns `assigneeAgentId: "$AGENT"` and a todo-ish status.

## 5. Run one heartbeat

```sh
npx paperclipai heartbeat run -a $AGENT --api-base $PC --json | tee /tmp/omp-run1.json
export RUN1=<run-id from the output>
```

The CLI wakes the agent (`POST /api/agents/:id/wakeup`,
`server/src/routes/agents.ts:6336`) and polls
`GET /api/heartbeat-runs/:runId` until a terminal status
(`cli/src/commands/heartbeat-run.ts`).

**Expected:** terminal `status: "succeeded"`, `exitCode: 0`.

### 5a. Run JWT present

The run JWT is never stored or returned (`heartbeat_runs` has no token column;
`packages/db/src/schema/heartbeat_runs.ts:31-140`). Prove it three ways:

1. Declared capability: `GET /api/adapters` →
   `capabilities.supportsLocalAgentJwt: true` (step 1).
2. Delivered to the supervisor while the run is live — the run-context pointer
   is 0600 and is deleted at settle, so catch it mid-run (start the wakeup in
   the background: `npx paperclipai heartbeat run -a $AGENT --api-base $PC &`):

   ```sh
   jq -r '{runId, apiUrl: .credentials.apiUrl, keyLen: (.credentials.apiKey | length), manifests}' \
     $HOST_ROOT/run-context/*/current.json
   ```

   **Expected:** `runId` equals `$RUN1`, `keyLen > 0`, `manifests.governance`
   `null` unless step 7 armed governance. If the pointer is already gone, the
   run settled; use evidence 3 and step 7 (a successful approval POST is proof
   the bridge held a valid run JWT).
3. The worker never carries it: the supervisor strips `PAPERCLIP_API_KEY` from
   the worker env (`src/host/worker.ts:40,82-92,176`).

   ```sh
   WORKER_PID=$(jq -r 'select(.runId == "'"$RUN1"'" and .state == "prompting") | .worker.pid' \
     $HOST_ROOT/ledger.jsonl | tail -1)
   tr '\0' '\n' < /proc/$WORKER_PID/environ | grep -c '^PAPERCLIP_API_KEY='   # expected: 0
   ```

### 5b. Work product posted

```sh
npx paperclipai issue comments $ISSUE --json | jq '.[-1] | {authorType, authorAgentId, createdByRunId, body}'
```

Route: `GET /api/issues/:id/comments`, written by the agent through its run
tools. `IssueComment` carries `authorType`, `authorAgentId`, `body` and
`createdByRunId` (`packages/shared/src/types/issue.ts:1051-1076`).

**Expected:** the last comment authored by `$AGENT` (`authorAgentId`) with
`createdByRunId` equal to `$RUN1`, containing the answer the issue asked for
(`pong`). A file deliverable instead appears under
`GET /api/issues/:id/work-products`
(`server/src/routes/issues.ts:10464-10476`; shape in
`packages/shared/src/validators/work-product.ts:81-97`) with `createdByRunId`
equal to `$RUN1`.

### 5c. `resultJson.hostRuntime` populated

```sh
npx paperclipai run get $RUN1 --json | jq '.resultJson | {status, transport, sessionSettled, agentInvoked, hostRuntime}'
```

Route: `GET /api/heartbeat-runs/:runId` (`server/src/routes/agents.ts:7159-7175`);
the adapter's `resultJson` is merged verbatim into `heartbeat_runs.result_json`
(`server/src/services/heartbeat/run-completion.ts:621-627`).

**Expected:**

```json
{
  "status": "completed",
  "transport": "host-rpc",
  "sessionSettled": true,
  "agentInvoked": true,
  "hostRuntime": {
    "workerPid": 12345,
    "reusedWorker": false,
    "settledBy": "outcome",
    "ledgerSeq": 5,
    "workerAgeMs": 4200
  }
}
```

`hostRuntime` absent means the adapter never reached a supervisor (the adapter
omits it on an unreachable-host result).
Note: the UI renders `resultJson` verbatim only in a failed run's "Failure
details" panel (`ui/src/pages/AgentDetail.tsx:4556-4580`); read it from the API.

### 5d. `resultJson.subagents` when subagents run

Ask for one: add a comment to the issue —
`npx paperclipai issue comment $ISSUE --body "Use one subagent (Task tool) to count the files in the task cwd, then post its answer."`
— and run a second heartbeat, then:

```sh
npx paperclipai run get <that-run-id> --json | jq '.resultJson.subagents'
```

**Expected:** absent when the run started no subagent; otherwise an array of
`{id, index, agent, status, description, parentToolCallId, ...}` (the settle
snapshot, `src/host/subagents.ts`). This requires the agent's
`subagentObservability` to be `summary` (the default) or `events`.

### 5e. Ledger record present

```sh
omp-host ledger tail 50 | jq -c 'select(.runId == "'"$RUN1"'") | {seq, state, cause, ompSessionId, sessionFile, usage, agentInvoked: .detail.agentInvoked, sessionSettled: .detail.sessionSettled}'
```

The journal is `$HOST_ROOT/ledger.jsonl` (0600, one JSONL record per transition;
`src/host/ledger.ts`).

**Expected** — in order: `leased`, `worker_ready`, `session_open`, `prompting`,
`settled`, `closed`, with:

| Field | Expected |
|---|---|
| `settled.detail.agentInvoked` | `true` |
| `settled.detail.sessionSettled` | `true` |
| `settled.usage.inputTokens` / `.outputTokens` | non-zero (cache-write counted as input; cache reads in `cachedInputTokens`) |
| `settled.usage.costUsd` | a number, or `null` with a `usage is unknown` `run.system` warning in the run events |
| `settled.ompSessionId` | the omp session id, matching `resultJson`/`sessionIdAfter` |
| `settled.sessionFile` | an existing `.jsonl` path under omp's session storage |

Also `omp-host stats --since 1h` (`src/host/cli.ts` stats) should count this run
under `states.settled` / `causes.clean`.

## 6. Second heartbeat — the session resumes

Run within the warm window (`OMP_HOST_WORKER_IDLE_MS`, default 20 min), so the
supervisor reuses the worker:

```sh
npx paperclipai heartbeat run -a $AGENT --api-base $PC --json > /tmp/omp-run2.json
export RUN2=<run-id>
npx paperclipai run get $RUN1 --json | jq -r '.sessionIdAfter'
npx paperclipai run get $RUN2 --json | jq '{sessionIdBefore, sessionIdAfter, status}'
npx paperclipai run get $RUN2 --json | jq '.usageJson | {sessionReused, taskSessionReused, freshSession, persistedSessionId}'
```

**Expected:**

| Evidence | Source | Expected |
|---|---|---|
| `sessionIdBefore` of run 2 | `heartbeat_runs.session_id_before` (`server/src/services/heartbeat.ts:3130-3134`) | equals run 1's `sessionIdAfter` |
| `usageJson.sessionReused` | `run-completion.ts:574-590` | `true` |
| `usageJson.freshSession` | same | `false` |
| `resultJson.hostRuntime.reusedWorker` | ledger settle record | `true` (same `workerPid` as run 1) |
| run 2's `session_open` ledger record | `src/host/ledger.ts` | same `ompSessionId` and `sessionFile` as run 1 |

Paperclip stores the resume identity in
`agent_task_sessions.session_params_json`, keyed by
`(company, agent, adapter_type, task_key)`
(`packages/db/src/schema/agent_task_sessions.ts:17-45`); the adapter's
`sessionCodec` serializes `sessionParams.acpSessionId`
(`src/server/adapters/acp/session-codec.ts` re-exports `packages/adapter-utils/src/acpx-engine/session-codec.ts:16-48`). If the supervisor had to start a
cold worker, a stored session omp cannot reopen is reported as a `run.system`
warning and the run starts fresh — `sessionReused: false` then means the worker
idled out, not that the adapter forgot the session. Send the second heartbeat
promptly to test the warm path.

## 7. Approval round-trip

Arm the governance gate on the agent's config (a restricted folder, so any write
under it asks the board). `governancePolicy` accepts JSON text or an object and
is read at `src/server/governance-manifest.ts:546-570`:

```sh
npx paperclipai agent update $AGENT --payload-json '{"adapterConfig":{
  "command":"omp",
  "cwd":"'"$HOME"'/work/omp-live-check",
  "timeoutSec":600,
  "sessionScope":"shared",
  "governancePolicy":{"restrictedFolders":["/tmp/omp-live-check-forbidden"]}
}}'
```

Then ask for a write under the restricted folder:

```sh
npx paperclipai issue comment $ISSUE --body "Write the word proof to /tmp/omp-live-check-forbidden/proof.txt using the write tool."
npx paperclipai heartbeat run -a $AGENT --api-base $PC --json > /tmp/omp-run3.json
```

**Expected in the run:** the tool call is held, the model reports
`paperclip governance: <tool> requires approval ...` (the bridge's block
reason, `holdForApproval` in `src/server/paperclip-bridge.ts:857-900`), and the
run settles with the call blocked rather than performed.

Read the approval:

```sh
npx paperclipai approval list -C $COMPANY --status pending --json | jq '.[] | {id, type, status, payload, issueIds}'
```

Route: `GET /api/companies/:companyId/approvals?status=pending`
(`server/src/routes/approvals.ts:215`); the bridge posts
`POST /api/companies/:companyId/approvals` with
`{type: "request_board_approval", payload: {tool, argumentsHash, risk, source: "omp_governance", reason?}, issueIds}`
(`src/server/paperclip-bridge.ts:927-946`).

**Expected row:** `type: "request_board_approval"`,
`payload.source: "omp_governance"`, `payload.tool` naming the tool,
`payload.argumentsHash` a hex hash, `status: "pending"`, `issueIds` includes
`$ISSUE`.

Approve and re-read:

```sh
npx paperclipai approval approve <approval-id> --decision-note "live check"
npx paperclipai approval get <approval-id> --json | jq '{status, decidedByUserId, decidedAt}'
```

Routes: `POST /api/approvals/:id/approve` (`server/src/routes/approvals.ts:296`),
`GET /api/approvals/:id` (`:224`); status values are
`pending|revision_requested|approved|rejected|cancelled`
(`approvals.status`, `packages/db/src/schema/approvals.ts:14`; values in `packages/shared/src/constants.ts:697-703`).

**Expected:** `status: "approved"`, a `decidedByUserId`, a `decidedAt`. The
bridge resolves the verdict with one bounded `GET /api/approvals/:id`
(`src/server/paperclip-bridge.ts:815`), so on the model's next attempt the
previously held call runs; a file-creation work product or comment proves it.

## 8. Wrap up

```sh
omp-host status                  # pid, epoch, workers, socket 0600 ok
omp-host stats --since 1h        # runs, states, causes, settle latency, worker reuse
omp-host ledger tail 20          # the last transitions, per run
omp-host stop                    # drains in-flight runs first
```

Leave the supervisor running if you want the adapter to keep reusing warm
workers; it idles out on its own after 30 minutes without workers
(`OMP_HOST_IDLE_MS`, `src/host/server.ts:81-86`).

## Failure signatures

| Symptom | Where | Cause |
|---|---|---|
| `omp_host_unavailable` | run `errorCode` | the supervisor never bound/answered; check `omp-host gc`, then `status` |
| `omp_host_worker_failed` | run `errorCode` | `omp --mode rpc` exited before `ready`; run `sh -lc 'exec omp --mode rpc'` once by hand |
| `omp_session_lease_held` | run `errorCode`, ledger `refused`/`lease_held` | a live run holds the `sessionKey`; wait for it or `omp-host gc` after a crash |
| `omp_governance_unavailable` | run `errorCode` | a governance policy is configured but `dist/paperclip-bridge.js` is missing/unreadable |
| `hostRuntime` absent from `resultJson` | `GET /api/heartbeat-runs/:id` | the adapter never reached a supervisor (see `errorCode`) |
| approval never appears | `GET /api/companies/:companyId/approvals` | no run JWT (step P2), or `governancePolicy` not armed (`omp_governance` absent from `payload.source`) |
| `sessionReused: false` | `usageJson` of the second run | the worker idled out (>20 min) or the session could not be reopened |

## What this runbook cannot prove

- Model quality, or omp features the adapter does not surface (`thinking`,
  context-pressure alignment, per-subagent transcripts).
- Paperclip UI rendering for `resultJson` nested keys on **successful** runs —
  the UI shows only `resultJson.summary`; the fields above are API-visible.
- A cold resume of a session created by `new_session`: omp keys sessions by cwd,
  and this lane does not change that runtime behavior. The warm path is what
  step 6 verifies.
