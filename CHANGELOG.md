# Changelog

## 0.10.0 — 2026-10-30

Model control and failover. Both are config-seam work: the levers existed in omp, the adapter was
driving them the expensive way or not at all.

- **Thinking without rotation** — the level now rides a run-child settings overlay
  (`defaultThinkingLevel`) instead of `--thinking` on `agentCommand`, so editing it no longer
  rotates the session or loses the prompt cache. Because omp keeps a resumed transcript's stored
  level, the adapter records the level each session started with and rotates **once** when the
  operator asks for a different one (with a `run.system` event naming both); an unknown or forked
  source is adopted rather than reset, so an upgrade never cold-starts a running employee. `off` is
  the one value the setting cannot express and still uses the flag. Live mid-session switching stays
  engine-blocked: omp accepts `set_config_option {configId:"thinking"}`, the engine sends only
  `model`/`effort`/`service_tier`.
- **Failover knobs** — `fallbackOn`, `fallbackRevertPolicy`, `waitForUsageReset` and `maxDelayMs`
  are validated and forwarded in the retry overlay; enum garbage is a typed config error instead of
  a file omp silently discards. `retry.fallbackChains.default` remains the chat-session chain.
- **Snapshot paging** — the session listing reads up to five `session/list` pages through
  `nextCursor` and reports `truncated`/`total` honestly instead of claiming a one-page world.

Honest limits: no live thinking switch (engine); no compaction alignment (the engine exposes no
context pressure); items 3 (MCP second half), 7b (gateway grants), 24 (cold-start) and 25 (sandbox)
are parked in `ROADMAP.md` with the missing upstream lever named.

## 0.9.0 — 2026-10-30

Correctness & containment. The features v0.4–v0.8 shipped but could not execute now do, and the
data that could cross tenant lines is fenced. Adapter-local; no upstream change required.

- **Run identity** — `supportsLocalAgentJwt`, `runtimeToolDelivery: "native_mcp"`,
  `supportsInstructionsBundle` + `instructionsPathKey`. Paperclip now mints the run token, the engine
  injects `PAPERCLIP_API_KEY`, and the session-snapshot/usage work products and the bridge's approval
  round-trip work instead of failing closed. The declared delivery channel is read: a run that offers
  connection tools without an MCP server carrying them emits one fail-soft warning. Warm-handle reuse
  is pinned to `0` for every run (a reused child keeps the spawning run's token, which would
  authenticate later work as an earlier run); an operator opt-in is dropped with a warning.
- **Tenancy fence** — the session snapshot is now one cwd-scoped ACP `session/list`; `_omp/*` is
  demoted to a counts-only diagnostic with no ids, cwds or titles. `sessionScope: "shared" |
  "isolated"` (default `shared`) fences the whole omp agent dir per employee; `isolated` requires
  `credentialMode: broker` and fails fast otherwise. Scope flips warn once instead of silently
  cold-starting, and the shared-scope posture is reported by `testEnvironment`.
- **Repair pass** — session-panel SQL now matches the real schema (`finished_at`,
  `heartbeat_run_id`, numeric cost) with a schema-derived fixture; `refreshModels` actually runs
  `omp models refresh` and returns rate cards; `detectModel` reads config instead of persisting a
  probe session and returns `provider/id`; work-product POSTs are gated on a real issue and bounded;
  the dead `_omp/subagents` probe is gone.
- **Cost truth** — omp's `pricingStatus` drives `costStatus`/`pricingProvenance` (`unknown` is
  `unpriced`, never free; declared-free is an estimate over a zero card; `included` is a
  reported zero with operator provenance). `usageByModel` is emitted only for single-model runs and
  omitted with an explanation when a fallback chain is configured.
- **Spend that stops** — `governancePolicy.budgetCapUsd` is forwarded as omp's `session.maxCost`
  (hard stop, subagents included) plus an adapter-derived `session.warnCost` at 80%, through a
  settings overlay so changing the number does not rotate the session. The bridge's soft cap stays
  the earlier signal.
- **Session correctness** — a per-`sessionKey` lease (atomic claim, owner-checked release, TTL
  reclaim) covers `execute()`, so two overlapping heartbeats cannot fork one session file silently;
  `session/fork` passes the source session's recorded cwd; `Could not restore model` rotates to a
  fresh session instead of stranding the employee. Context pressure stays unimplemented: the engine
  does not expose `used`/`size` on the adapter result, and parsing run logs is not a contract.
- **Governance integrity** — a materialized policy now fails the run when the bridge artifact is
  missing or unreadable (`omp_governance_unavailable`); `governancePolicy.restrictedFolders` is
  written to omp and enforced by the bridge (the omp prompt alone is auto-allowed on this lane);
  `deny-all` plus a policy that presumes a gated tool runs is rejected at config time.
- **Upgrade contract** — the tested omp minor is enforced by `testEnvironment`, `adapter-utils` is
  pinned to the tested build, and `omp models --json` is parsed by field rather than position.

Honest limits: no provider quota cards (`getQuotaWindows` takes no agent config, so it could only
report the host's login); no plan mode (no elicitation client on this lane, so approval would be
silently auto-granted); no stdio MCP; the `isolated` scope does not carry `models.yml`/`secrets.yml`;
retention is an operator command (`omp gc --agent-dir …`), not an adapter schedule; nothing here was
verified against a live Paperclip instance — the end-to-end smoke uses a stubbed engine.

## 0.8.0 — 2026-09-03

Governance & control: the omp employee runs *under policy*. Builds on the v0.7 bridge into a
governance extension. Mostly adapter-local; two capabilities honestly capped (advisory approval,
upstream-gated subagent view).

- **Guardrail policy engine** — a `governancePolicy` board field arms a `tool_call` handler in the
  bridge (the ONLY deterministic deny point on Paperclip's `approve-all` path): confine writes to the
  worktree (with realpath + symlink caveat), bash deny-lists, deny-tools, arg revision. Control tools
  (`yield`/`goal`/`think`/`todo`/`hub`) are never blocked so a run can't be stranded; the policy is
  re-read on mtime change (a warm session won't go stale).
- **Single-gate overlay** — folding `tools.approvalMode: yolo` into a run-child-only config makes the
  bridge the sole gate (no double-prompt with the ACP proxy).
- **Soft cost budget** — `message_end` accumulates per-session cost; past `budgetCapUsd`, mutating
  tools block (deny-by-complement) while read/control stay open. Honest: per-session (subagents get
  their own cap → up to (1+N)×cap), per-run by default (cold child), accumulates only under warm handles.
- **Endpoint routing** — `approvedEndpoints` emits a `disabledProviders` allow-list. Kept in a SEPARATE
  governance overlay folded only into the run child, never the side-channel `omp models ls` chain
  (the disabled list would otherwise shrink the catalog and oscillate) — verified live on omp 18.1.6;
  configured-model and fallback-chain providers are never disabled.
- **Advisory human approval** — an `approvalRequired` rule POSTs a `request_board_approval` (mirroring
  Paperclip's own tool-gateway shape; the run JWT can create + read, never decide) and holds the call
  with a pending reason — it can never wait on a human, since a `tool_call` handler is capped at ~30 s
  and fail-closed. A human decision wakes a NEW run, and because a warm `session/load` neither
  re-imports the bridge nor re-fires `session_start`, the pending branch **re-reads the verdict**
  (one bounded `GET /api/approvals/:id`) so the granted action actually executes instead of looping on
  its own stale cache; every other outcome (pending, rejected, unreadable, 403) holds, fail-closed.
  Deduped per tool+argument-hash so a model retry can't spam the board.
- **Session panel** surfaces per-run `model` (from `cost_events`, null-safe); v0.7 already had cost.
- **Subagent observability** — upstream ask drafted (`docs/upstream/omp-acp-subagent-bridge.md`; ACP
  lacks the RPC-mode subagent bridge) + a capability-gated consumer that no-ops until omp ships it.


## 0.7.0 — 2026-09-01

Native integration: skills as on-demand tools, and a board session panel — both adapter-local, no
upstream change required.

- **Lazy-skill bridge** — a `skillsAsTools` board field loads a static omp ExtensionAPI extension
  (`dist/skill-bridge.js`, injected via `--extension` on `agentCommand`) that registers each enabled
  company skill as a zero-arg **essential** native tool whose `execute()` returns the skill's
  `SKILL.md` **on demand** (re-read per call, so edits land in warm sessions). This replaces eager
  prompt-injection of all skill prose — less context, scales to many skills. The adapter materializes
  a `skills-manifest.json` (desired-filtered, provider-safe `paperclip_skill_*` names, description
  fallback) and hands its path to the run child via `config.env`; the bridge no-ops in side-channel
  children (which never get the manifest env). Toggling rotates the session (fingerprint).
- **Session panel plugin** — a new `paperclip-plugin-omp-session` package adds an agent `detailTab`
  showing recent runs' session-runtime, usage, and cost, read by the plugin worker via `ctx.db.query`
  over the whitelisted `heartbeat_runs` (`result_json.sessionRuntime`, `usage_json`) and `cost_events`
  (`cost_cents`→USD). Manifest validated against the strict plugin schema (namespace DB capabilities +
  `migrationsDir`); installed via `POST /api/plugins/install`.
- **Latent fixes carried in:** provider-safe tool names (a `/` in a tool name 400s every request);
  `loadMode:"essential"` (else extension tools are stripped from the model's schema); array-shaped
  `AgentToolResult.content`.

Descoped/deferred: the full cross-session omp browser in the panel (issue-scoped work products, not
worker-readable), rich per-session metadata (needs upstream `_omp` fields), and re-implementing
tool-event streaming (ACP already forwards it).


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
