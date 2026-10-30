import { defineConfig } from "vitest/config";

/**
 * The conformance project. Separate from the unit suite (`vitest.config.ts`)
 * because it spawns real processes — the real acpx engine against a scripted
 * omp build, and the real supervisor binary against a scripted RPC worker —
 * and it compares golden files, which the unit suite must not gate on.
 *
 * `npm run test:conformance` runs it. No Paperclip instance, no network.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["conformance/**/*.test.ts"],
    globalSetup: ["./test/global-setup.ts"],
    // Each cell spawns processes and waits on them; the default 5 s is a flake
    // budget, not a runtime bound (per-test overrides keep the tight ones).
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // The harness measures what processes do, so it must not share a worker's
    // module state with another file's fixtures.
    pool: "forks",
    fileParallelism: false,
  },
});
