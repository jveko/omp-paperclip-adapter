# Security policy

## Supported versions

Security fixes land on the latest `0.x` release. The supervisor protocol and the
adapter config are pre-1.0 and may change between minor versions; pin a commit or
tag if you need a frozen surface.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on
[`jveko/omp-paperclip-adapter`](https://github.com/jveko/omp-paperclip-adapter/security/advisories/new).
Do not open a public issue for an unpatched vulnerability. Include the version,
the affected component (adapter server, supervisor, worker, bridge or plugin),
and a reproduction if one is available.

## Trust model

The adapter runs inside the Paperclip server process and treats the following as
trusted: the instance operator, the Paperclip board/API, and any process running
as the same Unix uid.

- **Run token.** Paperclip mints a company-scoped API bearer per run
  (`supportsLocalAgentJwt`). The supervisor writes it into a `0600` run-context
  file under the instance's `omp-host` directory and rewrites that file before
  each prompt. It is stripped from the worker environment, so a warm worker
  cannot speak for an earlier run. The bridge uses it for the approval
  round-trip and the work-product POSTs.
- **Supervisor socket.** The unix socket and its directory are created `0600` /
  `0700`; the socket name carries a random token. Every connect re-checks the
  mode and owner and refuses anything wider than `0600`/`0700` or owned by
  another uid. Same-uid access is the authentication boundary; there is no
  cross-user isolation.
- **Ledger.** `ledger.jsonl` is `0600`, append-only and `fsync`ed. Credential-shaped
  strings and prompt/tool arguments are redacted before a record is written.
- **Command execution.** `command` and `agentCommand` come from agent
  configuration and are executed through `sh -lc` so a version-manager PATH
  works. Treat adapter configuration as code-execution privilege on the host.
- **Worker environment.** The configured `env` map is passed to the worker except
  `PAPERCLIP_API_KEY`, which is never placed in a live worker's environment.
- **Governance.** Guardrails and approval gates are enforced by the Paperclip
  bridge extension. They are not a sandbox: an agent still runs with the uid of
  the Paperclip server, and a run that is not governed has the agent's normal
  tool access.

## Out of scope

- A compromised Paperclip server, board credential, or instance admin.
- A malicious agent configuration (it already implies host command execution).
- Model providers and oh-my-pi itself; report those upstream.
- Findings that require root or the same uid as the server.
