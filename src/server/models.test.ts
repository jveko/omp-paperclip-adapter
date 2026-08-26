import { execFile } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseOmpModelsJson } from "./models.js";

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
