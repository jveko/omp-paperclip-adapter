// Single source of truth for the plugin manifest. Bundled to dist/manifest.js
// by scripts/build.mjs; the Paperclip plugin loader dynamic-imports that module
// (see server plugin-loader.js resolveManifestPath + loadManifestFromPath), so
// it must be an importable ESM default export, not a static .json file. Typed as
// the real manifest shape so a schema drift fails at build, not at install.
import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "omp-session",
  apiVersion: 1,
  version: "0.1.1",
  displayName: "OMP Sessions",
  description:
    "View an agent's recent runs: session runtime, usage, and cost from heartbeat_runs and cost_events.",
  author: "Oh My Pi (omp-paperclip-adapter)",
  categories: ["ui"],
  capabilities: [
    "database.namespace.migrate",
    "database.namespace.read",
    "agents.read",
    "ui.detailTab.register",
  ],
  entrypoints: {
    worker: "dist/worker.js",
    ui: "dist/ui",
  },
  database: {
    migrationsDir: "migrations",
    coreReadTables: ["heartbeat_runs", "cost_events"],
  },
  ui: {
    slots: [
      {
        type: "detailTab",
        id: "omp-session-overview",
        displayName: "OMP Sessions",
        entityTypes: ["agent"],
        exportName: "OmpSessionOverview",
      },
    ],
  },
};

export default manifest;
