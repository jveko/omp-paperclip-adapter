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
| \`warmHandleIdleMs\` | \`0\` | ms a persistent ACP process is kept warm between runs. Default 0 = closed after each turn; set > 0 (e.g. \`300000\`) to reuse a warm process across heartbeats |

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
