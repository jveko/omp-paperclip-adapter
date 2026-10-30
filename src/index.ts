export const type = "omp_local";

export const agentConfigurationDoc = `
## oh-my-pi (omp_local)

Runs oh-my-pi (omp) locally on the Paperclip host as an employee agent over the
ACP stdio transport.

### Use when
- You want to drive oh-my-pi locally as a Paperclip employee.
- You need sessions that resume and fork across heartbeats over ACP.
- You want custom providers from your local omp registry exposed to Paperclip.

### Don't use when
- You need webhook-style invocation.
- The workload is one-shot script only.
- omp is not installed on this machine.

### Core fields

| Field | Default | Notes |
|---|---|---|
| \`command\` | \`"omp"\` | binary name/path; must be absolute or on PATH of the service |
| \`agentCommand\` | \`<command> acp\` | explicit override wins |
| \`model\` | unset | any omp fuzzy pattern (\`provider/id\`); empty = omp default |
| \`mode\` | \`persistent\` | persistent keeps session state resumable across heartbeats; \`oneshot\` closes after each turn |
| \`permissionMode\` | \`approve-all\` | \`approve-reads\` / \`deny-all\` to tighten |
| \`nonInteractivePermissions\` | \`deny\` | fail-closed headless turns |
| \`timeoutSec\` / \`graceSec\` | 0 / 20 | unlimited run; SIGTERM grace |
| \`env\` | \`{}\` | incl. \`OMP_PAPERCLIP_BILLING_TYPE\` (\`api\` or \`subscription\`) |
| \`stateDir\`, \`instructionsFilePath\`, \`cwd\` | unset | passed through to engine |
| \`sessionScope\` | \`shared\` | \`shared\` = the host's one omp agent dir; \`isolated\` = this agent's own (requires \`credentialMode: broker\`) |
| \`sessionSnapshotDiagnostic\` | \`false\` | log counts from omp's host-wide \`_omp/*\` listing (never ids, cwds or titles) |
| \`warmHandleIdleMs\` | \`0\` | pinned to \`0\` on every run (see below). The engine sets \`PAPERCLIP_API_KEY\` only when it spawns the child, so a reused process would keep an earlier run's token |

### One run per session
- Every \`execute()\` holds a per-\`sessionKey\` lease under the agent state dir
  (\`omp-session-intel/leases/<hash>.json\`) for the whole run. A second heartbeat
  for the same session is refused with \`omp_session_lease_held\` instead of
  being queued (a queued heartbeat reports late). Two processes on one session
  file do not corrupt it — omp moves the non-owner's session to a fresh id on
  its first write — but the employee's transcript forks invisibly and the next
  run resumes only one branch.
- The lease is reclaimed when its owner pid is gone, or after its TTL (4 h, or
  \`timeoutSec\` + 5 min when that is longer). The file holds a pid, timestamps
  and the session key — never a credential.
- \`session/fork\` is sent the SOURCE session's recorded cwd (a bounded
  \`session/list\` by id), not the current run's: omp rejects the fork when they
  differ, and the source may live under another workspace. If the source is not
  in this agent dir's listing, the run warns and forks with the run's cwd.
- A resumed session whose recorded model no longer exists (\`Could not restore
  model <provider/id>\`, omp >= 18.6.3) is retried once on a fresh session
  instead of failing the employee; every other session-init failure stays
  terminal.

### Governance: the single gate, honestly
- With \`governancePolicy\` set, the run child gets \`tools.approvalMode: yolo\`
  through its own config overlay, so the bridge extension's \`tool_call\` handler
  is the only deterministic gate. A CONFIGURED yolo makes omp skip the
  permission request for edit/delete/move and allow bash directly, so the
  engine's ACP permission proxy sees almost none of it. The requests it still
  sees — a critical bash command, a restricted folder, any tool under omp's
  default approval mode — are answered purely by \`permissionMode\`; this lane
  has no human prompt, so \`approve-all\` (the default) auto-allows them and
  \`deny-all\` refuses them. \`deny-all\` together with \`pathScopes\` or
  \`argRevisions\` is therefore rejected at config time: the proxy would refuse
  exactly the calls those rules describe.
- \`governancePolicy.restrictedFolders\` is enforced twice. It is written to the
  child as omp's \`tools.restrictedFolders\` (omp raises a prompt in every
  approval mode, \`yolo\` included) and matched by the bridge, which posts a board
  approval and blocks the call. Under \`yolo\` the bridge is the ask a human
  actually sees; omp's prompt is the layer that still works outside ACP. Paths
  are taken as written (\`~\` and relative entries resolve against the run cwd).
- Before the run starts, the bridge artifact is checked: a materialized policy
  plus a missing or unreadable \`dist/paperclip-bridge.js\` fails the run with
  \`omp_governance_unavailable\` instead of taking \`yolo\` with no extension to
  replace omp's gate. That is file presence and readability only — whether
  omp's loader accepts the extension is not observable from the parent, and
  nothing on the ACP stream reports it.
- Plan mode is deliberately unavailable. \`plan\`, \`planMode\`, \`planEnabled\`,
  \`mode: plan\` and a \`--plan\` flag are config errors (\`omp_config_error\`):
  omp auto-approves a plan when the ACP client has no elicitation/form support,
  which would delete the approval step plan mode exists for.

### Session scope and the data fence
- \`sessionScope\` decides where omp keeps this employee's state. \`shared\`
  (default) is the historical behavior: every omp process on the host resolves
  the same agent dir (\`~/.omp/agent\`), so sessions, titles, caches, config and
  credentials are shared and omp's \`_omp/*\` listing can see them all.
  \`isolated\` sets \`PI_CODING_AGENT_DIR\` to
  \`<paperclip instance>/companies/<company>/acp-engine/agents/<agent>/omp-agent\`
  for the run child and every side channel, which is the only knob that scopes
  omp's session *reads* — \`--session-dir\` scopes writes only, and omp's
  \`session/list\`, \`_omp/sessions/listAll\`, \`_omp/projects/list\` and the
  load-by-id fallback all resolve under the agent dir regardless.
- \`isolated\` requires \`credentialMode: broker\`. The private dir holds no
  \`agent.db\`, so a local-login run would have no credentials; enabling
  \`isolated\` without the broker fails the run and the environment test with
  \`omp_config_error\`. The adapter never copies, links or moves a credential
  store.
- The operator's \`config.yml\` from the shared agent dir is folded back in via
  \`PI_CONFIG_FILES\` at the lowest precedence, so providers and model roles keep
  working after the switch. \`models.yml\` and \`secrets.yml\` cannot be carried
  that way: define those providers in \`config.yml\` (or via env) before
  switching, and re-login inside the fenced dir if you need per-employee
  credentials there.
- Switching scope starts an empty dir, so the employee's previous session is
  not resumed: the run warns once, naming the previous session's short id, and
  leaves the old transcript where it was. Reverting to \`shared\` also starts a
  fresh session (fingerprint and session id come from the run that just
  happened), and warns the same way — the legacy transcript is untouched but is
  not picked up automatically. Resume it explicitly on the host with
  \`PI_CODING_AGENT_DIR=<that dir> omp --resume <id>\` if its history matters.
- The session-snapshot work product is always scoped to the run's own cwd
  (ACP \`session/list\`); it never lists another tenant's sessions. The toggle
  \`sessionSnapshotDiagnostic\` additionally queries omp's host-wide \`_omp/*\`
  listing and logs **counts only**.
- Retention is an operator action, never a heartbeat side effect. To trim one
  agent's state: \`omp gc --agent-dir <paperclip instance>/companies/<company>/acp-engine/agents/<agent>/omp-agent --apply --json\`
  (dry-run without \`--apply\`). \`/dump anon\` remains the way to redact a
  transcript before sharing it; the adapter itself never exports transcript
  content, only session titles and ids of the run's own workspace.

### Thinking level and model failover, without a rotating fingerprint
- \`thinking\` is forwarded as omp's own \`defaultThinkingLevel\` through a
  run-scoped settings overlay (fixed filename, run child only), not as a
  \`--thinking\` flag on the agent command. The engine hashes the command line
  into the session key, so the flag made every level edit start a fresh
  session; the overlay path is stable and only its content changes. Setting the
  first level (or clearing the last) adds or removes that path, which the
  engine does fingerprint: one fresh session when the level first appears,
  never on a later edit of its value.
- The setting is not the strongest source. omp resolves a run's level as:
  CLI flag, then the level stored in the session's transcript
  (\`thinking_level_change\`), then a model-selector suffix, then the model
  catalog's own default effort, then \`defaultThinkingLevel\`. Every session
  stores its level at creation, so a resumed session keeps the level it
  started with. Editing \`thinking\` therefore rotates the session once — the
  adapter records the level each session was started with and restarts only
  when the operator asks for a different one — and the run says why. A level it
  cannot name is re-established the same way: a fork of a session this adapter
  never ran restarts once, on its next run, so its inherited level is known
  instead of silently frozen. An agent whose level is unchanged never rotates,
  and neither does a run that merely re-lists or re-reads that session. \`off\` stays a CLI flag because omp's
  setting has no \`off\` value (it discards one and reads \`high\`).
- Live switching mid-session is not available on this lane: omp's ACP accepts
  \`session/set_config_option {configId:"thinking"}\`, but the Paperclip engine
  only sends \`model\`, \`effort\` and \`service_tier\` (and omp rejects \`effort\`);
  that is an upstream ask, not a knob here.
- The quota-aware retry knobs ride the same overlay as the fallback chain
  (\`retry.fallbackOn\`, \`retry.fallbackRevertPolicy\`,
  \`retry.waitForUsageReset\`, \`retry.maxDelayMs\`). \`fallbackChain\` is written
  as \`retry.fallbackChains.default\`, the CHAT-session chain: omp never applies
  \`default\` to a model-kind role, which keeps its own chain or built-in order.
  A value outside an enum is a config error (\`omp_config_error\`) instead of a
  file omp would silently discard — an unknown \`fallbackOn\` reads back as
  \`any\`, so a warn would be a knob that does nothing.

### Run identity and control plane
- Paperclip mints a per-run token for this adapter (\`supportsLocalAgentJwt\`)
  and the engine injects it into the omp child as \`PAPERCLIP_API_KEY\`. That is
  a company-scoped API bearer for the employee's run: it is what makes the
  session-snapshot and usage work products and the bridge's board-approval
  round-trip possible, and it also lets the agent call any Paperclip API its
  run is entitled to. Hiring this adapter accepts that scope.
- Control tools arrive as MCP servers (\`runtimeToolDelivery: native_mcp\`):
  "Paperclip connections" whenever the run has a responsible user, plus
  "Paperclip projects" when the run is tied to an issue and an API base is
  configured. They reach the agent as \`mcp__*\` tools. A Paperclip build that
  ignores the flag delivers none of them; the run logs a \`connection tools are
  unavailable\` warning and continues.
- A managed AGENTS.md bundle is supported through \`instructionsFilePath\`: the
  engine renders that file into the run prompt and the ephemeral skills file
  merges the same path, so the bundle and \`skillsAsTools\` compose.
- Warm reuse is pinned off, deliberately. The engine injects
  \`PAPERCLIP_API_KEY\` into the child environment only when it spawns that
  child, and a warm-hit run reuses the process without re-spawning it. The
  installed engine (\`@paperclipai/adapter-utils\` 2026.824.x) drops a warm
  handle for neither a run token nor run-scoped MCP servers, so reuse would make
  later heartbeats speak with the FIRST run's token: their work products and
  approval requests would authenticate as that earlier run (wrong attribution,
  not just a failure). Because that is an audit-integrity defect, the adapter
  forces \`warmHandleIdleMs: 0\` on every run, whatever the config says, and logs
  one \`warm-handle reuse pinned to 0\` warning when a configured value was
  ignored. The only exception is the fork run's own single-run 50 ms pin, which
  exists so the fork resume can save and immediately close its handle. Lift the
  pin in \`buildOmpAcpConfig\` only when the dependency's engine discards
  run-scoped credentials on reuse (contract HEAD already does; see ROADMAP items
  1/8).
- No provider quota windows are reported. \`getQuotaWindows\` receives no adapter
  config, so it could only report the Paperclip host's omp login rather than the
  employee's; the subscription-quota card stays empty for this adapter.

### Notes
- Permissions are owned by the engine knobs \`permissionMode\` +
  \`nonInteractivePermissions\`. The adapter never passes \`--auto-approve\` on the
  command line; unattended employees keep the default approve posture only as a
  conscious operator choice at hire time.
- Spend control has two layers, and the operator sets one number:
  \`governancePolicy.budgetCapUsd\`. The omp child receives it as its own session
  cost cap (\`session.maxCost\`) through a run-child-only config overlay, so omp
  refuses the next model request once the session tree — subagents included —
  reaches it; a request already in flight can finish past the cap. The same
  overlay carries an early-warning threshold at 80 % of the cap, rounded to
  cents (the adapter's own heuristic, omitted when it would round to zero or to
  the cap itself). The bridge's \`budgetCapUsd\` remains the soft, earlier signal:
  it can only refuse a tool call, and each session (subagents included) keeps
  its own copy. Adding or clearing the key changes \`PI_CONFIG_FILES\` and so
  rotates the session once; changing only the number does not.
- Cost truth follows omp's own pricing status rather than a zero rate card: a
  model with a declared rate card is reported as an estimate, a declared-free
  or subscription-included model as a known zero, and a model omp cannot price
  as \`unpriced\` — never as free. Unpriced runs are what the board's
  \`unpricedUsagePolicy\` blocks, so a custom provider with no rate card stalls
  the employee at the budget gate instead of spending silently.
- \`refreshModels\` runs \`omp models refresh\` (online, single-flight, at most once
  a minute) and then lists the catalog, so a retired model disappears on the
  first refresh; it returns each model's rate card and context window.
  \`detectModel\` reads the configured \`modelRoles.default\` instead of opening a
  throwaway ACP session, and returns the same \`provider/id\` shape the catalog
  uses. Both use the default omp on PATH, not any agent's \`command\` override.
- Tested against omp **18.13.x** (verified 18.13.1). \`testEnvironment\` fails for
  a command named \`omp\` outside that minor, and \`peerDependencies\` declares the
  same range (\`@oh-my-pi/pi-coding-agent\`, optional so npm does not pull the
  CLI for you). Wrapper commands report their own version, so they are reported
  as unverified rather than failed. \`omp models ls --json\` is unversioned; the
  catalog is parsed by field, so a missing or future \`schemaVersion\` is inert.
- systemd may strip mise shims from PATH; prefer an absolute \`command\`.
`.trim();

export { createServerAdapter } from "./server/index.js";
