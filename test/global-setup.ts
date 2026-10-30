// Vitest global setup (runs once per suite): the adapter ships
// `dist/paperclip-bridge.js`, and the governance fail-closed check reads it.
// Tests run from `src`, so on a fresh checkout the artifact is absent and every
// governed run would be rejected for the wrong reason. Build the REAL extension
// here instead of writing a stand-in: a placeholder would be readable, would
// register nothing, and could be mistaken for a loadable bridge outside the
// suite. `npm run build:bridge` is the same esbuild invocation.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

export default async function setup(): Promise<void> {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const bridge = path.join(root, "dist", "paperclip-bridge.js");
  if (!existsSync(bridge)) {
    await build({
      entryPoints: [path.join(root, "src", "server", "paperclip-bridge.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile: bridge,
      logLevel: "silent",
    });
  }
  // The acceptance tests spawn the REAL supervisor binary (the adapter spawns
  // it in production), so build the shipped target here rather than a stand-in.
  // Rebuilt unconditionally: a stale local bundle would silently test old host
  // code, which is exactly the failure these tests exist to catch.
  const host = path.join(root, "dist", "omp-host.js");
  {
    await build({
      entryPoints: [path.join(root, "src", "host", "main.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      banner: { js: "#!/usr/bin/env node" },
      outfile: host,
      logLevel: "silent",
    });
  }
}
