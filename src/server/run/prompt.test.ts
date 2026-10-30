import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { buildManagedPrompt } from "./prompt.js";

function ctx(overrides: Record<string, unknown> = {}): AdapterExecutionContext {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1", companyId: "co-1", name: "A", adapterType: "omp_local", adapterConfig: null,
    },
    runtime: { sessionId: null, sessionParams: {}, sessionDisplayId: null, taskKey: "t" },
    config: {},
    context: {
      taskId: "0b8f0d5e-9a10-4f6a-8f2b-1c2d3e4f5a6b",
      paperclipTaskMarkdown: "## Task\n\nFix the thing.",
      paperclipWake: { reason: "issue_assigned", issue: { title: "Fix it" } },
    },
    onLog: async () => {},
    onEvent: async () => {},
    ...overrides,
  } as AdapterExecutionContext;
}

describe("managed prompt", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "omp-prompt-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("orders instructions, wake, task context and template like the engine", async () => {
    const instructions = path.join(dir, "AGENTS.md");
    await writeFile(instructions, "Always be careful.", "utf8");
    const { prompt, commandNotes } = await buildManagedPrompt({
      ctx: ctx(),
      instructionsFilePath: instructions,
      resumedSession: false,
      env: { PAPERCLIP_API_URL: "http://pb.test:3100", PI_CONFIG_FILES: "/a.yml" },
      onLog: async () => {},
    });
    expect(commandNotes[0]).toContain("Loaded agent instructions");
    expect(prompt.indexOf("Always be careful.")).toBeLessThan(prompt.indexOf("## Task"));
    expect(prompt).toContain("The above agent instructions were loaded from");
    expect(prompt).toContain("Fix the thing.");
    // The heartbeat template is upstream's default (`DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE`),
    // rendered with the run identity. Its copy moves between adapter-utils
    // releases (2026.1023.0 replaced the execution contract with the
    // connection-tools guidance), so pin the identity it renders rather than a
    // sentence the dependency owns.
    expect(prompt).toContain("You are agent agent-1 (A).");
    expect(prompt).toContain("PAPERCLIP_API_URL");
    expect(prompt).not.toContain("PAPERCLIP_API_KEY");
    expect(prompt).not.toContain("PI_CONFIG_FILES");
  });

  it("uses the resume-delta shape for a resumed session", async () => {
    const { prompt } = await buildManagedPrompt({
      ctx: ctx(),
      instructionsFilePath: null,
      resumedSession: true,
      env: {},
      onLog: async () => {},
    });
    // A resumed session gets the wake delta instead of the full heartbeat
    // template; the template's rendered identity is not repeated.
    expect(prompt).not.toContain("You are agent agent-1 (A).");
    expect(prompt).toContain("Fix the thing.");
  });

  it("warns and continues when the instructions file is unreadable", async () => {
    const logs: string[] = [];
    const { prompt, commandNotes } = await buildManagedPrompt({
      ctx: ctx(),
      instructionsFilePath: path.join(dir, "missing.md"),
      resumedSession: false,
      env: {},
      onLog: async (_stream, chunk) => {
        logs.push(chunk);
      },
    });
    expect(logs.join("")).toContain("could not read agent instructions file");
    expect(commandNotes[0]).toContain("could not be read");
    expect(prompt).toContain("You are agent agent-1 (A).");
  });

  it("renders the configured prompt template with the run identity", async () => {
    const { prompt } = await buildManagedPrompt({
      ctx: ctx({ config: { promptTemplate: "Agent {{agent.id}} run {{run.id}}" } }),
      instructionsFilePath: null,
      resumedSession: false,
      env: {},
      onLog: async () => {},
    });
    expect(prompt).toContain("Agent agent-1 run run-1");
  });
});
