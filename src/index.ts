export const type = "omp_local";

export const agentConfigurationDoc = `
## oh-my-pi (omp_local)

Runs oh-my-pi (omp) locally on the Paperclip host as an employee agent through
the per-instance \`omp-host\` supervisor, which drives an \`omp --mode rpc\` worker
and keeps the run ledger. ACP remains the probe lane only (session listing and
fork, \`_omp/*\`, model discovery, the environment probe).

### Use when
- You want to drive oh-my-pi locally as a Paperclip employee.
- You need sessions that resume and fork across heartbeats.
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
| \`permissionMode\` | \`approve-all\` | \`approve-reads\` / \`deny-all\` to tighten |
| \`timeoutSec\` | 0 | run deadline; 0 = unlimited. Cancellation grace is the supervisor's 5 s (\`OMP_HOST_CANCEL_GRACE_MS\`) |
| \`env\` | \`{}\` | incl. \`OMP_PAPERCLIP_BILLING_TYPE\` (\`api\` or \`subscription\`) |
| \`instructionsFilePath\`, \`cwd\` | unset | passed through to the run child |
| \`sessionScope\` | broker: \`isolated\`; otherwise \`shared\` | \`isolated\` = this agent's own omp agent dir (requires \`credentialMode: broker\`); \`shared\` = the host's one omp agent dir (a cross-tenant choice under broker credentials) |
| \`sessionSnapshotDiagnostic\` | \`false\` | log counts from omp's host-wide \`_omp/*\` listing (never ids, cwds or titles) |
| \`subagentObservability\` | \`summary\` | \`off\` / \`summary\` / \`events\` |

### One run per session
- The supervisor holds a per-\`sessionKey\` lease under the agent state dir
  (\`omp-session-intel/leases/<hash>.json\`) for the whole run; it is the only
  holder, and the adapter acquires none. A second heartbeat for the same
  session is refused with \`omp_session_lease_held\` instead of being queued (a
  queued heartbeat reports late). Two processes on one session
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
- A stored session omp cannot open — a removed model (\`Could not restore model
  <provider/id>\`), a moved directory — starts a fresh session instead of
  failing the employee, and the run warns which id it dropped.

### Governance: the single gate, honestly
- With \`governancePolicy\` set, the run child gets \`tools.approvalMode: yolo\`
  through its own config overlay, so the bridge extension's \`tool_call\` handler
  is the only deterministic gate. A CONFIGURED yolo makes omp skip the
  permission request for edit/delete/move and allow bash directly, so omp's
  permission proxy sees almost none of it. The requests it still
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
  nothing in the run stream reports it.
- Plan mode is deliberately unavailable. \`plan\`, \`planMode\`, \`planEnabled\`,
  \`mode: plan\` and a \`--plan\` flag are config errors (\`omp_config_error\`):
  omp auto-approves a plan when the ACP client has no elicitation/form support,
  which would delete the approval step plan mode exists for.

### Session scope and the data fence
- \`sessionScope\` decides where omp keeps this employee's state, and its
  default follows \`credentialMode\`. With \`credentialMode: broker\` it defaults
  to \`isolated\`: broker credentials arrive per run, so fencing the agent dir
  costs nothing and the cross-tenant window is not the default. Any other
  credential mode defaults to \`shared\` (its credential store lives in the
  shared agent dir, and the environment test says so).
- \`shared\` is the historical behavior: every omp process on the host resolves
  the same agent dir (\`~/.omp/agent\`), so sessions, titles, caches, config and
  credentials are shared and omp's \`_omp/*\` listing can see them all. Choosing
  \`shared\` explicitly under broker credentials still works, but the run and the
  environment test warn that it makes those sessions cross-tenant readable
  (and resumable by another employee).
- \`isolated\` sets \`PI_CODING_AGENT_DIR\` to
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
  \`--thinking\` flag on the agent command: the overlay path is stable, so an
  edit never changes the worker's argv.
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
- Live switching mid-session is not available: the supervisor opens the session
  with the run's level and sends no per-turn level request. That is an upstream
  ask, not a knob here.
- The quota-aware retry knobs ride the same overlay as the fallback chain
  (\`retry.fallbackOn\`, \`retry.fallbackRevertPolicy\`,
  \`retry.waitForUsageReset\`, \`retry.maxDelayMs\`). \`fallbackChain\` is written
  as \`retry.fallbackChains.default\`, the CHAT-session chain: omp never applies
  \`default\` to a model-kind role, which keeps its own chain or built-in order.
  A value outside an enum is a config error (\`omp_config_error\`) instead of a
  file omp would silently discard — an unknown \`fallbackOn\` reads back as
  \`any\`, so a warn would be a knob that does nothing.

### Subagent observability
- \`subagentObservability\` decides how much of omp's subagent tree this run
  subscribes to. \`summary\` (the default) sends \`set_subagent_subscription\`
  at omp's \`progress\` level before the prompt and relays each
  lifecycle/progress frame as a bounded \`omp.subagent\` event: id, index,
  agent, status, description, parentToolCallId, lastUpdate. \`events\`
  subscribes at omp's \`events\` level and adds the subagent's own event type
  and a content-free summary (a tool event names the tool; a message event
  carries no text). \`off\` subscribes to nothing and adds no result evidence.
  An unknown value is a config error (\`omp_config_error\`).
- The payload is bounded at the source: credential-shaped strings (JWTs,
  bearer tokens, common token prefixes) are replaced with \`[redacted]\`,
  every string is capped at 200 characters, the live stream at 100
  \`omp.subagent\` frames per run (then one warning; the snapshot still counts
  everything), and the snapshot's item list at 50. Subagent prompts, tool
  arguments, tokens and full transcripts are never carried — the adapter
  reads an allowlist of fields, not the frame.
- At settle, a run that observed subagent activity reads \`get_subagents\`
  and records \`resultJson.subagents\`:
  \`{ total, completed, failed, cancelled, running, items }\`. Counts come from
  the lifecycle this run saw; \`running\` includes what omp's roster still
  holds. A run with no subagent activity adds no \`subagents\` field, and a
  detached subagent from an earlier run on the same warm worker is never
  attributed to a later run.
- Cancelling or timing out a run kills the worker's process group, so its
  children die with it. A per-subagent \`cancel_subagent\`/\`steer_subagent\`
  control path is deliberately not exposed: the board contract for it does
  not exist, and a control command without one would be a knob nobody owns.

### Run identity and control plane
- Paperclip mints a per-run token for this adapter (\`supportsLocalAgentJwt\`)
  and the supervisor writes it into the run-context file the run child reads;
  it is never placed in a live worker's environment. That is
  a company-scoped API bearer for the employee's run: it is what makes the
  session-snapshot and usage work products and the bridge's board-approval
  round-trip possible, and it also lets the agent call any Paperclip API its
  run is entitled to. Hiring this adapter accepts that scope.
- Control tools arrive as MCP servers (\`runtimeToolDelivery: native_mcp\`):
  "Paperclip connections" whenever the run has a responsible user, plus
  "Paperclip projects" when the run is tied to an issue and an API base is
  configured. They reach the agent as omp host tools. A Paperclip build that
  ignores the flag delivers none of them, and the run has no connection tools.
- A managed AGENTS.md bundle is supported through \`instructionsFilePath\`: the
  supervisor renders that file into the run prompt and the ephemeral skills
  file merges the same path, so the bundle and \`skillsAsTools\` compose.
- A warm worker is reused across heartbeats only for the same session key, argv,
  bridge, agent dir, cwd and omp version; a run-scoped credential never enters
  the worker's environment, so a reused process cannot speak for an earlier
  run. The token travels in the per-run context file instead, which the
  supervisor rewrites before each prompt.
- No provider quota windows are reported. \`getQuotaWindows\` receives no adapter
  config, so it could only report the Paperclip host's omp login rather than the
  employee's; the subscription-quota card stays empty for this adapter.

### Notes
- Permissions are owned by the omp knob \`permissionMode\`. The adapter never
  passes \`--auto-approve\` on the command line; unattended employees keep the
  default approve posture only as a conscious operator choice at hire time.
- Legacy ACP-lane keys \`mode\`, \`stateDir\`, \`nonInteractivePermissions\` and
  \`graceSec\` are ignored by the supervisor lane; use \`timeoutSec\` for a run
  deadline. They stay accepted so existing agent configs keep loading.
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
- Compatibility is a probed capability set, not a version number. Tested
  against omp **18.13.x** (verified live on 18.13.1) and **18.14.x**
  (source-audited against the 18.14.0 release, not executed on this host), and
  \`peerDependencies\` declares that range (\`@oh-my-pi/pi-coding-agent\`,
  optional so npm does not pull the CLI for you). \`testEnvironment\` probes
  what the build actually exposes — ACP \`session/list\`, \`session/fork\`,
  \`_session/steering\`, \`_omp/extensions\`, the \`mode|model|thinking\` config
  ids, the \`session.maxCost\` / \`tools.restrictedFolders\` /
  \`defaultThinkingLevel\` settings keys, the \`models refresh\` /
  \`session lease\` / \`gc\` verbs, and the
  \`get_session_stats\` / \`set_host_tools\` / \`set_subagent_subscription\`
  worker frames — and names the feature each absent surface disables. A build
  outside the tested minors is a **warning** that points at those checks; only
  a different major is an error. The worker-frame group is what the run needs;
  the ACP group describes the probe lane. Wrapper commands report their own version, so they are
  reported as unverified rather than failed. The probe is cached per command
  and environment; the run path only reads that cache and never spawns a probe
  of its own. \`omp models ls --json\` is unversioned; the catalog is parsed by
  field, so a missing or future \`schemaVersion\` is inert.
- A provider-qualified model selector (anything containing \`/\`) must be an
  exact catalog id, for \`model\` and every \`fallbackChain\` leg. omp 18.14
  resolves such a selector exactly: a near match fails instead of selecting a
  sibling, and a chain leg that does not resolve is skipped, silently
  narrowing the chain. The adapter therefore resolves slash-containing values
  against \`omp models ls --json\` and refuses the run with
  \`omp_config_error\` (and the environment test with an error check) naming
  the value. Bare selectors (\`opus\`) keep omp's fuzzy matching. When the
  catalog cannot be read at all, the selectors pass through as before with a
  warning instead of failing the run.
- systemd may strip mise shims from PATH; prefer an absolute \`command\`.
`.trim();

export { createServerAdapter } from "./server/index.js";
