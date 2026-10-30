// Test harness: the adapter ships `dist/paperclip-bridge.js` (the governance /
// skills extension). Tests run from `src`, so before a `npm run build` the
// fail-closed artifact check would reject every governed test run for the wrong
// reason. Create a stand-in only when the real build output is absent; the
// check reads readability, never behavior, and the tests that exercise the
// failure path point `bridgePath` somewhere else on purpose.
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifact = path.join(root, "dist", "paperclip-bridge.js");
if (!existsSync(artifact)) {
  await mkdir(path.dirname(artifact), { recursive: true });
  await writeFile(artifact, "// test stand-in for the built paperclip bridge\n", "utf8");
}
