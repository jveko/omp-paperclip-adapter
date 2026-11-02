import { build } from "esbuild";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

// esbuild baseline configs from the SDK bundler presets (worker + ui).
// The manifest is a static manifest.json validated separately by the test
// suite, so only the worker and ui bundles are emitted here.
const presets = createPluginBundlerPresets({ uiEntry: "src/ui.tsx" });

// Sourcemaps stay out of the published package: the worker bundle is the
// shipping artifact, and its .map alone was half the tarball's unpacked size.
await Promise.all([
  build({ ...presets.esbuild.manifest, sourcemap: false }),
  build({ ...presets.esbuild.worker, sourcemap: false }),
  build({ ...presets.esbuild.ui, sourcemap: false }),
]);

console.log("Built dist/manifest.js, dist/worker.js and dist/ui/ (esbuild presets from @paperclipai/plugin-sdk/bundlers)");
