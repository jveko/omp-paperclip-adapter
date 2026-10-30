import { execFile } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  detectOmpConfiguredModel, listOmpModels, normalizeOmpModelId, parseOmpModelsJson,
  refreshOmpModelCatalog, type OmpModelInfo,
} from "./models.js";
import { deriveDefaultTimeoutSec } from "./acp.js";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

const execFileMock = vi.mocked(execFile);

function spawnResult(stdout: string, err: Error | null = null) {
  return (
    _cmd: string,
    _args: string[],
    _opts: unknown,
    cb: (e: Error | null, out: string) => void,
  ) => {
    cb(err, stdout);
  };
}

async function freshModels() {
  vi.resetModules();
  return import("./models.js");
}

const SAMPLE = JSON.stringify({
  models: [
    { provider: "openrouter", id: "glm-5.2", selector: "glm-5.2", name: "GLM-5.2",
      contextWindow: 200000, maxTokens: 8192, reasoning: true,
      thinking: [], input: ["text"],
      cost: { input: 1.5, output: 6, cacheRead: 0.15, cacheWrite: 1.875 } },
    { provider: "openrouter", id: "preview-free",
      name: "Preview Free", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    { provider: "openrouter", id: "no-cost", name: "No Cost" },
  ],
});

describe("parseOmpModelsJson", () => {
  it("maps entries to paperclip shape", () => {
    const out = parseOmpModelsJson(SAMPLE);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({
      id: "openrouter/glm-5.2", label: "GLM-5.2", contextWindow: 200000,
    });
  });
  it("maps an entry without cost to cost:undefined", () => {
    const out = parseOmpModelsJson(SAMPLE);
    expect(out[2]).toEqual({
      id: "openrouter/no-cost", label: "No Cost",
      contextWindow: undefined, cost: undefined, pricingStatus: undefined,
    });
  });
  it("returns [] on malformed json or missing models array", () => {
    expect(parseOmpModelsJson("garbage")).toEqual([]);
    expect(parseOmpModelsJson("{}")).toEqual([]);
    expect(parseOmpModelsJson("null")).toEqual([]);
  });
});

describe("parseOmpModelsJson pricingStatus", () => {
  it.each(["fixed", "free", "included", "variable", "unknown"] as const)(
    "carries omp's %s status instead of guessing from the cost card",
    (status) => {
      const parsed = parseOmpModelsJson(JSON.stringify({
        models: [{
          provider: "openrouter", id: "m", pricingStatus: status,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        }],
      }));
      expect(parsed[0].pricingStatus).toBe(status);
    },
  );

  it("drops an unrecognized pricingStatus rather than passing it through", () => {
    const parsed = parseOmpModelsJson(JSON.stringify({
      models: [{ provider: "openrouter", id: "m", pricingStatus: "cheapish" }],
    }));
    expect(parsed[0].pricingStatus).toBeUndefined();
  });

  it("keeps a partial zero cost card for timeout derivation", () => {
    const partial = { input: 0, output: 0 };
    const parsed = parseOmpModelsJson(JSON.stringify({
      models: [{ provider: "openrouter", id: "partial-free-model", cost: partial }],
    }));
    expect(deriveDefaultTimeoutSec(parsed[0].cost)).toBe(1800);
  });
});

describe("refreshOmpModelCatalog", () => {
  beforeEach(() => {
    vi.useRealTimers();
    execFileMock.mockReset();
  });

  it("runs omp models refresh before listing the refreshed catalog", async () => {
    const models = await freshModels();
    const calls: string[][] = [];
    execFileMock.mockImplementation((cmd: string, args: string[], _o: unknown, cb: (e: null, out: string) => void) => {
      calls.push([cmd, ...args]);
      cb(null, args.includes("refresh") ? "" : SAMPLE);
    });
    const out = await models.refreshOmpModelCatalog();
    expect(calls).toEqual([
      ["omp", "models", "refresh"],
      ["omp", "models", "ls", "--json"],
    ]);
    expect(out).toHaveLength(3);
  });

  it("shares one refresh and listing across concurrent callers", async () => {
    const models = await freshModels();
    let release: (() => void) | null = null;
    execFileMock.mockImplementation((_c: string, args: string[], _o: unknown, cb: (e: null, out: string) => void) => {
      const done = () => cb(null, args.includes("refresh") ? "" : SAMPLE);
      if (args.includes("refresh")) release = done;
      else done();
    });
    const first = models.refreshOmpModelCatalog();
    const second = models.refreshOmpModelCatalog();
    await Promise.resolve();
    release?.();
    expect(await first).toEqual(await second);
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it("does not re-run the network refresh inside the cooldown, but still lists", async () => {
    vi.useFakeTimers();
    const models = await freshModels();
    execFileMock.mockImplementation((_c: string, args: string[], _o: unknown, cb: (e: null, out: string) => void) =>
      cb(null, args.includes("refresh") ? "" : SAMPLE));
    await models.refreshOmpModelCatalog();
    await models.refreshOmpModelCatalog();
    expect(execFileMock).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(60_000);
    await models.refreshOmpModelCatalog();
    expect(execFileMock).toHaveBeenCalledTimes(5);
    vi.useRealTimers();
  });

  it("recovers when the refresh command fails: the listing still runs", async () => {
    const models = await freshModels();
    execFileMock.mockImplementation((_c: string, args: string[], _o: unknown, cb: (e: Error | null, out: string) => void) =>
      args.includes("refresh") ? cb(new Error("network down"), "") : cb(null, SAMPLE));
    expect(await models.refreshOmpModelCatalog()).toHaveLength(3);
  });
});

describe("detectOmpConfiguredModel", () => {
  beforeEach(() => {
    vi.useRealTimers();
    execFileMock.mockReset();
  });

  it("reads modelRoles.default and returns the resolved provider/id", async () => {
    const models = await freshModels();
    execFileMock.mockImplementation((_c: string, args: string[], _o: unknown, cb: (e: null, out: string) => void) =>
      cb(null, args[0] === "config"
        ? JSON.stringify({ key: "modelRoles", value: { default: "glm-5.2" }, type: "record" })
        : SAMPLE));
    expect(await models.detectOmpConfiguredModel()).toEqual({
      model: "openrouter/glm-5.2", provider: "openrouter", source: "config:modelRoles.default",
    });
    expect(execFileMock).toHaveBeenNthCalledWith(
      1, "omp", ["config", "get", "modelRoles", "--json"],
      expect.objectContaining({ timeout: 20_000 }), expect.any(Function),
    );
  });

  it("returns null without listing when no default role is configured", async () => {
    const models = await freshModels();
    execFileMock.mockImplementation((_c: string, _a: string[], _o: unknown, cb: (e: null, out: string) => void) =>
      cb(null, JSON.stringify({ key: "modelRoles", value: {} })));
    expect(await models.detectOmpConfiguredModel()).toBeNull();
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("returns null when the selector is not in the catalog", async () => {
    const models = await freshModels();
    execFileMock.mockImplementation((_c: string, args: string[], _o: unknown, cb: (e: null, out: string) => void) =>
      cb(null, args[0] === "config"
        ? JSON.stringify({ key: "modelRoles", value: { default: "retired/model" } })
        : SAMPLE));
    expect(await models.detectOmpConfiguredModel()).toBeNull();
  });

  it("returns null when omp is missing or config output is unreadable", async () => {
    const models = await freshModels();
    execFileMock.mockImplementation((_c: string, _a: string[], _o: unknown, cb: (e: Error, out: string) => void) =>
      cb(new Error("ENOENT"), ""));
    expect(await models.detectOmpConfiguredModel()).toBeNull();
  });
});

describe("listOmpModels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("spawns omp models ls --json on first call and serves cache within TTL", async () => {
    const { listOmpModels } = await freshModels();
    execFileMock.mockImplementation(spawnResult(SAMPLE));
    const first = await listOmpModels();
    expect(first).toHaveLength(3);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock).toHaveBeenCalledWith(
      "omp",
      ["models", "ls", "--json"],
      expect.objectContaining({ timeout: 20_000 }),
      expect.any(Function),
    );
    const second = await listOmpModels();
    expect(second).toEqual(first);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("force:true re-spawns the command", async () => {
    const { listOmpModels } = await freshModels();
    execFileMock.mockImplementation(spawnResult(SAMPLE));
    await listOmpModels();
    await listOmpModels({ force: true });
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it("does not cache failed or empty output", async () => {
    const { listOmpModels } = await freshModels();
    execFileMock.mockImplementation(spawnResult("", new Error("spawn failed")));
    expect(await listOmpModels()).toEqual([]);
    execFileMock.mockImplementation(spawnResult(SAMPLE));
    expect(await listOmpModels()).toHaveLength(3);
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });
  it("honors a custom args array for the catalog command", async () => {
    const { listOmpModels } = await freshModels();
    execFileMock.mockImplementation(spawnResult(SAMPLE));
    await listOmpModels({ command: "node", args: ["fake-acp.mjs", "models", "ls", "--json"] });
    expect(execFileMock).toHaveBeenCalledWith(
      "node",
      ["fake-acp.mjs", "models", "ls", "--json"],
      expect.objectContaining({ timeout: 20_000 }),
      expect.any(Function),
    );
  });
});

describe("listOmpModels env threading", () => {
  it("forwards env to the omp models subprocess", async () => {
    execFileMock.mockReset();
    execFileMock.mockImplementation((_c: string, _a: string[], _o: unknown, cb: (e: null, out: string) => void) =>
      cb(null, JSON.stringify({ models: [{ provider: "brokerco", id: "m", label: "L", priced: false }] })));
    const models = await listOmpModels({ command: "omp", force: true, env: { OMP_AUTH_BROKER_URL: "http://b" } });
    const opts = execFileMock.mock.calls[0][2] as { env?: Record<string, string> };
    expect(opts.env?.OMP_AUTH_BROKER_URL).toBe("http://b");
    expect(models[0].id).toBe("brokerco/m");
  });
  it("keys the cache by env (no cross-agent catalog leak)", async () => {
    const emit = (marker: string) => (_c: string, _a: string[], _o: unknown, cb: (e: null, out: string) => void) =>
      cb(null, JSON.stringify({ models: [{ provider: marker, id: "m", label: "L", priced: false }] }));
    execFileMock.mockReset(); execFileMock.mockImplementation(emit("A"));
    await listOmpModels({ command: "omp", env: { MARKER: "A" } });
    execFileMock.mockImplementation(emit("B"));
    const b = await listOmpModels({ command: "omp", env: { MARKER: "B" } }); // different env → cache miss
    expect(b[0].id).toBe("B/m");
  });
});

describe("normalizeOmpModelId", () => {
  const models: OmpModelInfo[] = [
    { id: "zai/glm-5.2", label: "GLM 5.2", priced: true },
    { id: "anthropic/claude-sonnet-4-20250514", label: "Claude Sonnet 4", priced: true },
    { id: "openrouter/auto", label: "OpenRouter Auto", priced: false },
  ];

  it("passes an exact provider/id through unchanged", () => {
    expect(normalizeOmpModelId("zai/glm-5.2", models)).toBe("zai/glm-5.2");
  });

  it("resolves a bare id suffix to its full provider/id", () => {
    expect(normalizeOmpModelId("glm-5.2", models)).toBe("zai/glm-5.2");
  });

  it("resolves by label", () => {
    expect(normalizeOmpModelId("Claude Sonnet 4", models)).toBe("anthropic/claude-sonnet-4-20250514");
  });

  it("returns null for an unknown model", () => {
    expect(normalizeOmpModelId("nonexistent-model", models)).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(normalizeOmpModelId("", models)).toBeNull();
  });

  it("resolves a bare id prefix to its full provider/id", () => {
    expect(normalizeOmpModelId("claude-sonnet-4", models)).toBe(
      "anthropic/claude-sonnet-4-20250514",
    );
  });

  it("returns null for whitespace-only input", () => {
    expect(normalizeOmpModelId("   ", models)).toBeNull();
  });

  it("trims surrounding whitespace before matching", () => {
    expect(normalizeOmpModelId("  glm-5.2  ", models)).toBe("zai/glm-5.2");
  });

  it("matches labels case-insensitively", () => {
    expect(normalizeOmpModelId("claude sonnet 4", models)).toBe(
      "anthropic/claude-sonnet-4-20250514",
    );
  });

  it("gives exact id precedence over an earlier label match", () => {
    const precedence: OmpModelInfo[] = [
      { id: "a/x", label: "y", priced: true },
      { id: "b/y", label: "z", priced: true },
    ];
    expect(normalizeOmpModelId("b/y", precedence)).toBe("b/y");
  });
});
