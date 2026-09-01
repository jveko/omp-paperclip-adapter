import { build } from "esbuild";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

// esbuild baseline configs from the SDK bundler presets (worker + ui).
// The manifest is a static manifest.json validated separately by the test
// suite, so only the worker and ui bundles are emitted here.
const presets = createPluginBundlerPresets({ uiEntry: "src/ui.tsx" });

await Promise.all([
  build(presets.esbuild.worker),
  build(presets.esbuild.ui),
]);

console.log("Built dist/worker.js and dist/ui/ (esbuild presets from @paperclipai/plugin-sdk/bundlers)");
