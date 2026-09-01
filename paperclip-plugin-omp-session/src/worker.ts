import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("omp-session plugin worker starting");
    // v0.7 Feature B — Task B2 fills this in: register the
    // "omp-session-overview" data handler over heartbeat_runs + cost_events.
    // B1 ships the scaffold only (this no-op setup), enough to produce the
    // worker bundle and validate the manifest.
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
