import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { pluginManifestV1Schema } from "@paperclipai/shared/validators/plugin";

const manifest = JSON.parse(
  await readFile(new URL("../manifest.json", import.meta.url), "utf8"),
);

describe("paperclip-plugin-omp-session manifest", () => {
  it("validates against the strict plugin manifest schema", () => {
    const result = pluginManifestV1Schema.safeParse(manifest);
    expect(result.success).toBe(true);
  });

  it("declares database namespaced capabilities, never a bare 'database' capability", () => {
    const result = pluginManifestV1Schema.safeParse(manifest);
    if (!result.success) throw result.error;
    const capabilities = result.data.capabilities;
    expect(capabilities).toContain("database.namespace.migrate");
    expect(capabilities).toContain("database.namespace.read");
    // Regression guard: the spec review caught a bare "database" capability
    // which is not in the strict enum (validators/plugin.js capabilities list).
    expect(capabilities).not.toContain("database");
  });

  it("declares a database migrationsDir and both whitelisted core read tables", () => {
    const result = pluginManifestV1Schema.safeParse(manifest);
    if (!result.success) throw result.error;
    expect(result.data.database?.migrationsDir).toBe("migrations");
    expect(result.data.database?.coreReadTables).toContain("heartbeat_runs");
    expect(result.data.database?.coreReadTables).toContain("cost_events");
  });

  it("declares a detailTab UI slot on the agent entity", () => {
    const result = pluginManifestV1Schema.safeParse(manifest);
    if (!result.success) throw result.error;
    expect(result.data.entrypoints.worker).toBeTruthy();
    expect(result.data.entrypoints.ui).toBeTruthy();
    const slot = result.data.ui?.slots?.find((s) => s.id === "omp-session-overview");
    expect(slot).toBeDefined();
    expect(slot?.type).toBe("detailTab");
    expect(slot?.entityTypes).toContain("agent");
    expect(slot?.exportName).toBeTruthy();
  });

  it("rejects a manifest with a bare 'database' capability (mutation guard)", () => {
    const bad = {
      ...manifest,
      capabilities: ["database", "database.namespace.read", "agents.read"],
    };
    const result = pluginManifestV1Schema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("rejects a manifest missing database.migrationsDir (mutation guard)", () => {
    const bad = {
      ...manifest,
      database: { coreReadTables: ["heartbeat_runs", "cost_events"] },
    };
    const result = pluginManifestV1Schema.safeParse(bad);
    expect(result.success).toBe(false);
  });
});
