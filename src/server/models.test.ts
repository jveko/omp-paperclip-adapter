import { execFile } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeOmpModelId, parseOmpModelsJson, type OmpModelInfo } from "./models.js";
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
  it("maps entries to paperclip shape with declared-cost flag", () => {
    const out = parseOmpModelsJson(SAMPLE);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({
      id: "openrouter/glm-5.2", label: "GLM-5.2",
      contextWindow: 200000, priced: true,
    });
    expect(out[1]).toMatchObject({ id: "openrouter/preview-free", priced: false });
  });
  it("maps an entry without cost to priced:false and cost:undefined", () => {
    const out = parseOmpModelsJson(SAMPLE);
    expect(out[2]).toEqual({
      id: "openrouter/no-cost", label: "No Cost",
      contextWindow: undefined, cost: undefined, priced: false,
    });
  });
  it("returns [] on malformed json or missing models array", () => {
    expect(parseOmpModelsJson("garbage")).toEqual([]);
    expect(parseOmpModelsJson("{}")).toEqual([]);
    expect(parseOmpModelsJson("null")).toEqual([]);
  });
});

describe("parseOmpModelsJson priced flag", () => {
  it("marks a model with all-zero cost as free (priced=false)", () => {
    const parsed = parseOmpModelsJson(JSON.stringify({
      models: [{ provider: "openrouter", id: "free-model", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    }));
    expect(parsed[0].priced).toBe(false);
  });

  it("marks a model with nonzero input/output cost as priced", () => {
    const parsed = parseOmpModelsJson(JSON.stringify({
      models: [{ provider: "openrouter", id: "paid-model", cost: { input: 3, output: 15 } }],
    }));
    expect(parsed[0].priced).toBe(true);
  });

  it("marks a model priced via cache-only cost as priced", () => {
    const parsed = parseOmpModelsJson(JSON.stringify({
      models: [{ provider: "openrouter", id: "cache-model", cost: { input: 0, output: 0, cacheRead: 0.0028, cacheWrite: 0.0028 } }],
    }));
    expect(parsed[0].priced).toBe(true);
  });

  it("treats a partial zero card (cache fields omitted) as free in both priced and timeout derivation", () => {
    const partial = { input: 0, output: 0 };
    const parsed = parseOmpModelsJson(JSON.stringify({
      models: [{ provider: "openrouter", id: "partial-free-model", cost: partial }],
    }));
    expect(parsed[0].priced).toBe(false);
    expect(deriveDefaultTimeoutSec(parsed[0].cost)).toBe(1800);
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