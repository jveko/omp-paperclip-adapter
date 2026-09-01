-- No-op placeholder migration. This plugin owns no tables — it reads the
-- whitelisted core tables (heartbeat_runs, cost_events) via ctx.db.query.
-- Paperclip requires a declared migrationsDir to contain at least one DDL or
-- namespace-scoped backfill statement; COMMENT ON SCHEMA is the least-side-effect
-- valid statement (it creates no object). The schema name is
-- derivePluginDatabaseNamespace("omp-session") = plugin_<slug>_<sha256(id)[0:10]>,
-- which the host creates before running migrations. If the manifest id changes,
-- regenerate this identifier.
COMMENT ON SCHEMA "plugin_omp_session_c68491a09f" IS 'omp-session: reads core tables only; owns no schema objects';
