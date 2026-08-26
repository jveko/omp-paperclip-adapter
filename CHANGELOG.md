# Changelog

## 0.1.0 — 2026-08-26

Initial release.

- ACP-lane execution: spawns `omp acp` through Paperclip's ACPX engine custom lane
  (sessions, resume, warm handles, timeouts, cost attribution inherited from the engine).
- Model discovery via `omp models ls --json` with declared-rate-card awareness.
- ACP handshake + active-model probe used by testEnvironment diagnostics.
- Five-check environment validation (cwd, binary, version, handshake, billing env).
- Self-contained ui-parser bundle for sandboxed transcript rendering.
- Billing identity injection (`OMP_PAPERCLIP_BILLING_TYPE=api|subscription`).
