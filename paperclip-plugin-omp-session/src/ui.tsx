import { usePluginData } from "@paperclipai/plugin-sdk/ui";
import {
  DataTable,
  MetricCard,
  StatusBadge,
  Spinner,
} from "@paperclipai/plugin-sdk/ui";
import type { PluginDetailTabProps } from "@paperclipai/plugin-sdk/ui";
import type { StatusBadgeVariant } from "@paperclipai/plugin-sdk/ui";

// -- Data shapes (mirror worker.ts) -----------------------------------------

interface SessionRuntime {
  fork: { requested: string; applied: boolean; activeSessionId: string } | null;
  rotation: { reason: string; at: string; sessionKey: string } | null;
  mcpServerCount: number | null;
}

interface RunOverview {
  id: string;
  status: string | null;
  startedAt: string | null;
  endedAt: string | null;
  sessionRuntime: SessionRuntime | null;
  usage: Record<string, number> | null;
  costUsd: number;
}

interface OmpSessionOverview {
  runs: RunOverview[];
  summary: {
    runCount: number;
    totalSessionSeconds: number | null;
    totalUsage: Record<string, number>;
    totalCostUsd: number;
  };
}

// -- Helpers -----------------------------------------------------------------

function formatDuration(seconds: number | null): string {
  if (seconds === null) return "\u2014";
  const total = Math.round(seconds);
  if (total < 60) return `${total}s`;
  if (total < 3600) {
    const m = Math.floor(total / 60);
    const s = total % 60;
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function formatCost(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

function statusToBadgeVariant(status: string | null): StatusBadgeVariant {
  switch (status) {
    case "completed":
      return "ok";
    case "failed":
      return "error";
    case "running":
      return "pending";
    default:
      return "info";
  }
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return "\u2014";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function formatUsage(usage: Record<string, number> | null): string {
  if (!usage) return "\u2014";
  const parts = Object.entries(usage).map(
    ([k, v]) => `${k}: ${v.toLocaleString()}`,
  );
  return parts.join(" | ");
}

function formatSessionRuntime(rt: SessionRuntime | null): string {
  if (!rt) return "\u2014";
  const parts: string[] = [];
  if (rt.fork) parts.push(`fork:${rt.fork.activeSessionId}${rt.fork.applied ? "" : "(stale)"}`);
  if (rt.rotation) parts.push(`rot:${rt.rotation.reason}`);
  if (rt.mcpServerCount != null) parts.push(`mcp:${rt.mcpServerCount}`);
  return parts.join(" ") || "\u2014";
}

// -- Component ---------------------------------------------------------------

export function OmpSessionOverview({ context }: PluginDetailTabProps) {
  const { data, loading, error } = usePluginData<OmpSessionOverview>(
    "omp-session-overview",
    { agentId: context.entityId },
  );

  if (loading) {
    return (
      <div style={{ padding: 16, textAlign: "center" }}>
        <Spinner /> Loading OMP sessions…
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: 16, color: "var(--color-error)" }}>
        Error: {error.message}
      </div>
    );
  }

  if (!data || data.runs.length === 0) {
    return (
      <div style={{ padding: 16, color: "var(--color-muted)" }}>
        No OMP session data found for this agent.
      </div>
    );
  }

  const { summary, runs } = data;

  // DataTable is typed against Record<string, unknown> rows (SDK's fixed
  // generic); our typed RunOverview[] carries the same columns via string keys.
  const rows = runs as unknown as Record<string, unknown>[];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24, padding: 16 }}>
      {/* Summary cards */}
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        <MetricCard label="Runs" value={summary.runCount} />
        <MetricCard label="Duration" value={formatDuration(summary.totalSessionSeconds)} />
        <MetricCard label="Total Cost" value={formatCost(summary.totalCostUsd)} />
      </div>

      {/* Recent runs table */}
      <DataTable
        columns={[
          {
            key: "id",
            header: "Run ID",
            width: "120px",
            render: (v) => {
              const id = String(v ?? "");
              return id.length > 12 ? `${id.slice(0, 12)}\u2026` : id;
            },
          },
          {
            key: "status",
            header: "Status",
            width: "100px",
            render: (v, row) => {
              const status = String(v ?? "");
              return (
                <StatusBadge
                  label={status || "unknown"}
                  status={statusToBadgeVariant(status)}
                />
              );
            },
          },
          {
            key: "startedAt",
            header: "Started",
            width: "160px",
            render: (v) => formatTimestamp(v as string | null),
          },
          {
            key: "sessionRuntime",
            header: "Session Runtime",
            width: "200px",
            render: (v) => formatSessionRuntime(v as SessionRuntime | null),
          },
          {
            key: "usage",
            header: "Usage",
            width: "240px",
            render: (v) => formatUsage(v as Record<string, number> | null),
          },
          {
            key: "costUsd",
            header: "Cost",
            width: "80px",
            render: (v) => formatCost(v as number),
          },
        ]}
        rows={rows}
        emptyMessage="No recent runs."
      />
    </div>
  );
}

export default OmpSessionOverview;