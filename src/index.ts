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
| \`warmHandleIdleMs\` | \`0\` | ms a persistent ACP process is kept warm between runs. Default 0 = closed after each turn. > 0 is NOT safe with run identity: the engine sets \`PAPERCLIP_API_KEY\` only when it spawns the child, so a reused process keeps the spawning run's token (see below) |

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
- Warm reuse cannot carry run identity. The engine injects
  \`PAPERCLIP_API_KEY\` in the child environment only when it spawns that child,
  and a warm-hit run reuses the process without re-spawning it. With the pinned
  engine (\`@paperclipai/adapter-utils\` 2026.824.x) nothing drops a warm handle
  for run-scoped credentials, so a \`warmHandleIdleMs > 0\` employee keeps the
  FIRST run's token in every later heartbeat: its bridge requests authenticate
  as that earlier run, so approvals stall fail-closed and work products are
  refused. Keep \`warmHandleIdleMs\` at its default \`0\` until an engine that
  discards run-scoped credentials on reuse ships (contract HEAD does; see
  ROADMAP items 1/8). Default installs are unaffected: 0 closes the process
  after each turn.
- No provider quota windows are reported. \`getQuotaWindows\` receives no adapter
  config, so it could only report the Paperclip host's omp login rather than the
  employee's; the subscription-quota card stays empty for this adapter.

### Notes
- Permissions are owned by the engine knobs \`permissionMode\` +
  \`nonInteractivePermissions\`. The adapter never passes \`--auto-approve\` on the
  command line; unattended employees keep the default approve posture only as a
  conscious operator choice at hire time.
- Custom providers without rate cards report $0 cost even when tokens burn.
  Check \`omp models ls --json\` rate cards before assuming a model is free.
- \`refreshModels\`/\`detectModel\` use the default omp on PATH, not any agent's
  \`command\` override.
- systemd may strip mise shims from PATH; prefer an absolute \`command\`.
`.trim();

export { createServerAdapter } from "./server/index.js";
