import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// Mock the plugin UI SDK so the component under test receives fixture data
// and the shared components render as simple, deterministic markup.
const usePluginDataMock = vi.hoisted(() => vi.fn());

vi.mock("@paperclipai/plugin-sdk/ui", async () => {
  const react = await vi.importActual<typeof import("react")>("react");
  const h = react.createElement;

  const mockComponents = {
    DataTable: ({
      columns,
      rows,
    }: {
      columns: { header: string; key: string; render?: (v: unknown, r: unknown) => unknown }[];
      rows: unknown[];
    }) =>
      h(
        "table",
        { "data-testid": "data-table", "data-row-count": String(rows.length) },
        h(
          "thead",
          null,
          h("tr", null, columns.map((c) => h("th", { key: c.key }, c.header))),
        ),
        h(
          "tbody",
          null,
          rows.map((row) =>
            h(
              "tr",
              { key: (row as { id?: string }).id },
              columns.map((c) => {
                const val = (row as Record<string, unknown>)[c.key];
                const child = c.render ? c.render(val, row) : String(val);
                return h("td", { key: c.key }, child as React.ReactNode);
              }),
            ),
          ),
        ),
      ),
    MetricCard: ({ label, value }: { label: string; value: number | string }) =>
      h("div", { "data-testid": "metric", "data-label": label }, String(value)),
    StatusBadge: ({ label, status }: { label: string; status: string }) =>
      h("span", { "data-testid": "status-badge", "data-status": status }, label),
    Spinner: () => h("span", { "data-testid": "spinner" }, "\u2026"),
  };
  return {
    usePluginData: usePluginDataMock,
    ...mockComponents,
  };
});

import { OmpSessionOverview } from "../src/ui.jsx";
import { createElement } from "react";

const OVERVIEW = {
  runs: [
    {
      id: "run-abc123def456",
      status: "completed",
      startedAt: "2026-09-01T10:00:00Z",
      endedAt: "2026-09-01T10:30:00Z",
      sessionRuntime: {
        fork: { requested: "sess-a", applied: true, activeSessionId: "sess-a" },
        rotation: { reason: "maxRuns", at: "2026-09-01T09:00:00Z", sessionKey: "sk" },
        mcpServerCount: 2,
      },
      usage: { prompt_tokens: 1500, completion_tokens: 800 },
      costUsd: 7,
    },
    {
      id: "run-2",
      status: "failed",
      startedAt: "2026-09-01T11:00:00Z",
      endedAt: "2026-09-01T11:05:00Z",
      sessionRuntime: {
        fork: { requested: "sess-x", applied: false, activeSessionId: "sess-b" },
        rotation: { reason: "maxAgeHours", at: "2026-09-01T10:00:00Z", sessionKey: "sk2" },
        mcpServerCount: null,
      },
      usage: { prompt_tokens: 500, completion_tokens: 100 },
      costUsd: 3,
    },
  ],
  summary: {
    runCount: 2,
    totalSessionSeconds: 2100,
    totalUsage: { prompt_tokens: 2000, completion_tokens: 900 },
    totalCostUsd: 10,
  },
};

const CONTEXT = { entityId: "agent-1" } as never;

function render() {
  return renderToStaticMarkup(createElement(OmpSessionOverview, { context: CONTEXT }));
}

describe("OmpSessionOverview detailTab", () => {
  beforeEach(() => {
    usePluginDataMock.mockReset();
  });

  it("calls usePluginData with the overview key and the agent entityId", () => {
    usePluginDataMock.mockReturnValue({ data: OVERVIEW, loading: false, error: null, refresh: vi.fn() });
    render();
    expect(usePluginDataMock).toHaveBeenCalledWith("omp-session-overview", {
      agentId: "agent-1",
    });
  });

  it("renders summary metrics and a recent-runs table from fixture data", () => {
    usePluginDataMock.mockReturnValue({ data: OVERVIEW, loading: false, error: null, refresh: vi.fn() });
    const html = render();

    // Summary metric cards
    expect(html).toContain('data-label="Runs"');
    expect(html).toContain('data-label="Duration"');
    expect(html).toContain('data-label="Total Cost"');
    // run count + total session (30m + 5m = 35m) + cost $10.00
    expect(html).toContain('data-label="Runs">2');
    expect(html).toContain('data-label="Duration">35m');
    expect(html).toContain('data-label="Total Cost">$10.00');

    // Table renders both rows and column headers
    expect(html).toContain('data-testid="data-table"');
    expect(html).toContain('data-row-count="2"');
    expect(html).toContain("Run ID");
    expect(html).toContain("Status");
    expect(html).toContain("Session Runtime");

    // Per-run data: status badges with mapped variants
    expect(html).toContain('data-status="ok">completed');
    expect(html).toContain('data-status="error">failed');
    // Cost per run
    expect(html).toContain("$7.00");
    expect(html).toContain("$3.00");
  });

  it("shows a loading indicator while fetching", () => {
    usePluginDataMock.mockReturnValue({ data: null, loading: true, error: null, refresh: vi.fn() });
    const html = render();
    expect(html).toContain('data-testid="spinner"');
    expect(html).toContain("Loading OMP sessions");
  });

  it("renders an error message on bridge error", () => {
    usePluginDataMock.mockReturnValue({
      data: null,
      loading: false,
      error: { code: "WORKER_ERROR", message: "boom" },
      refresh: vi.fn(),
    });
    const html = render();
    expect(html).toContain("Error: boom");
  });

  it("renders an empty state when there are no runs", () => {
    usePluginDataMock.mockReturnValue({
      data: { runs: [], summary: { runCount: 0, totalSessionSeconds: null, totalUsage: {}, totalCostUsd: 0 } },
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
    const html = render();
    expect(html).toContain("No OMP session data found for this agent.");
  });
});