import { usePluginData } from "@paperclipai/plugin-sdk/ui";
import type { PluginDetailTabProps } from "@paperclipai/plugin-sdk/ui";

/**
 * Agent detailTab placeholder for v0.7 Feature B.
 *
 * Task B3 fills this in: render a recent-runs DataTable plus usage/cost
 * MetricCards from the worker's "omp-session-overview" data handler. B1 ships
 * only the scaffold component so the UI bundle builds and the detailTab slot
 * (declared in manifest.json) resolves to this export.
 */
export function OmpSessionOverview({ context }: PluginDetailTabProps) {
  const { data, loading, error } = usePluginData("omp-session-overview", {
    agentId: context.entityId,
  });

  if (loading) {
    return <div>Loading OMP sessions…</div>;
  }
  if (error) {
    return <div>Error: {error.message}</div>;
  }
  return <div>OMP Sessions overview (placeholder — {data === undefined ? "no data" : "data ready"})</div>;
}

export default OmpSessionOverview;
