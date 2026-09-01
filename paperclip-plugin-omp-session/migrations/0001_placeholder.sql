-- omp-session plugin: placeholder migration (v0.7 Feature B, Task B1).
-- B2 adds the real heartbeat/cost read queries against the whitelisted core
-- tables; no plugin-owned schema exists yet, so this is a no-op that keeps the
-- migrationsDir resolvable and the migration runner idempotent.
SELECT 1;
