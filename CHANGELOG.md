# Changelog

## 0.6.0 — 2026-08-31

Fleet control: per-agent runtime directives over the omp child, adapter-local and unblocked.

- **Thinking directive** — a `thinking` board field forwards omp's `--thinking <level>` to the run's
  omp child via `agentCommand`. Chosen over the config overlay (a silent no-op: fixed filename → no
  fingerprint change, and omp restores the transcript's stored level on resume) and over ACP
  `set_config_option` (the engine sends the wrong key, `effort`, which omp rejects). Because
  `agentCommand` is inside the run fingerprint, **changing the level rotates the session** so the new
  level applies; it is a documented no-op on resumed and fork runs (needs an upstream engine seam).
- **Effort-key strip** — `buildOmpAcpConfig` now also drops `reasoningEffort`/`modelReasoningEffort`
  (the engine reads four effort keys; a stray value made it send `key: "effort"` and abort the run).
- **Token-split fix** — the catalog, `--version`, and broker-health probes extract the command base by
  `indexOf("acp")` instead of stripping a trailing `acp`, so a `--thinking`-bearing `agentCommand` no
  longer mangles those probes into starting an ACP server.
- **Worktree side-channel cwd** — the fork/query session cwd now mirrors the engine's precedence
  (`paperclipWorkspace.cwd` → `config.cwd` → stale `storedParams.cwd` → `process.cwd()`), so a
  `git_worktree` run's session snapshot/fork query the actual worktree, not a stale directory.

Descoped after research: the `auth-gateway` metering proxy (no per-request cost metering — the v0.5
broker + per-run usage work products already attribute cost per agent), cost-per-heartbeat as a live
board field (`getConfigSchema` is context-free), and the `mode` knob (no engine seam). ExtensionAPI
bridge and the plugin-SDK session panel are deferred to v0.7.


## 0.5.0 — 2026-08-31

Fleet runtime: omp employees become configurable, credential-shared, and observable as a population.

- **`ompEnv` env-threading** — one env map now reaches every omp spawn (the run's ACP child and
  the previously env-blind side-channel catalog/probe/fork/query/usage calls), fixing a latent bug
  where a broker-configured agent resolved its catalog and reads against the server's credentials.
  The model-catalog cache is now keyed per command+env (no cross-agent leak).
- **`credentialMode: local | broker`** — point an employee at an operator-run `omp auth-broker serve`
  via `OMP_AUTH_BROKER_URL`/`OMP_AUTH_BROKER_TOKEN` (bound to a company `secret_ref`); fail-closed
  validation; a `testEnvironment` broker-health probe. Consumption only — the adapter never starts the broker.
- **Per-agent model-fallback chains** — a `fallbackChain` config field materializes a
  `retry.fallbackChains` omp overlay injected via `PI_CONFIG_FILES` (omp's native TurnRecovery is
  default-on but ships pointed at nothing). Appends to any operator `PI_CONFIG_FILES`.
- **OTLP export diagnostic** — `testEnvironment` reports whether OTLP export is armed and warns on a
  non-`http/protobuf` protocol (omp emits only http/protobuf; Paperclip has no built-in sink).
- **MCP HTTP-lane verification** — forwarded MCP server count reported on the run path
  (`resultJson.sessionRuntime.mcpServerCount`); stdio remains upstream-blocked.
- **Usage & cost reporting** — an `omp-usage` work product: broker `/v1/usage` (HTTP, no omp session)
  plus a rate-card × recent-run cost-per-heartbeat estimate (incl. cache-read tokens), digest-deduped.

Deferred (documented): serving-model attribution after native failover (needs an upstream `_omp`
surface), the `auth-gateway` metering proxy, the plugin-SDK session panel, and fork/compaction
un-gating (blocked on the cross-run session-resume fingerprint instability — see 0.4.0 note).


## 0.4.0 — 2026-08-28

Session runtime: omp employees become inspectable and steerable at the session level.

- Initialize-only ACP side channel: `_omp/projects/list`, `_omp/sessions/listAll`,
  `_omp/chats/byCwd` read persisted sessions with zero session pollution.
- Session browser: snapshot work products (`provider: omp-session`) on the issue whenever
  the session landscape changes.
- Fork-as-action: operator picks a persisted session id; the next run forks it and resumes
  the fork (warm-handle collision resolved via per-run `warmHandleIdleMs`).
- Governance toggles: force-fresh and fork are config-schema directives; compaction
  rotates sessions after configured run-count/age thresholds.
- Static `sessionManagement` declaration (corrects the compaction-disabled default).

**Known limitations (deployment-gated):** fork-as-action and compaction-rotation depend on
the engine resuming a session across runs (`canResume` requires a stable session fingerprint).
On the codan instance the engine's session fingerprint varies run-to-run even with identical
config/cwd/skills, so cross-run resume does not occur and those two capabilities are
currently inert there (they are correct in code and activate once resume works). Session
browser, force-fresh, the governance schema, and the `sessionManagement` declaration are
verified working. Root cause is engine-side (Paperclip), not the adapter — tracked upstream.

## 0.1.0 — 2026-08-26

Initial release.

- ACP-lane execution: spawns `omp acp` through Paperclip's ACPX engine custom lane
  (sessions, resume, warm handles, timeouts, cost attribution inherited from the engine).
- Model discovery via `omp models ls --json` with declared-rate-card awareness.
- ACP handshake + active-model probe used by testEnvironment diagnostics.
- Five-check environment validation (cwd, binary, version, handshake, billing env).
- Self-contained ui-parser bundle for sandboxed transcript rendering.
- Billing identity injection (`OMP_PAPERCLIP_BILLING_TYPE=api|subscription`).
