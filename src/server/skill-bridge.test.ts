import { afterEach, describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import registerSkillBridge from "./skill-bridge.js";

/* ------------------------------------------------------------------ */
/*  Mock pi                                                           */
/* ------------------------------------------------------------------ */

interface CapturedTool {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  loadMode: unknown;
  execute: () => Promise<{ content: { type: string; text: string }[] }>;
}

interface MockPi {
  on: (event: string, handler: () => Promise<void>) => void;
  registerTool: (tool: CapturedTool) => void;
}

function makeMockPi(): {
  registered: CapturedTool[];
  handler: () => Promise<void>;
} {
  const registered: CapturedTool[] = [];
  let handler: (() => Promise<void>) | undefined;
  const pi: MockPi = {
    on: (_event, h) => {
      handler = h;
    },
    registerTool: (tool) => {
      registered.push(tool);
    },
  };
  registerSkillBridge(pi); // sync — registers the session_start handler
  return { registered, handler: () => handler!() };
}

/* ------------------------------------------------------------------ */
/*  Fixture helpers                                                    */
/* ------------------------------------------------------------------ */

async function captureTools(
  skills: { name: string; toolName: string; description: string; markdown: string }[],
): Promise<CapturedTool[]> {
  const dir = path.join(tmpdir(), `skill-bridge-test-${randomUUID()}`);
  await fs.mkdir(dir, { recursive: true });

  const entries: {
    name: string;
    toolName: string;
    description: string;
    markdownPath: string;
  }[] = [];
  const markdownFiles: string[] = [];

  for (const skill of skills) {
    const mdPath = path.join(dir, `${skill.toolName}.md`);
    await fs.writeFile(mdPath, skill.markdown, "utf8");
    markdownFiles.push(mdPath);
    entries.push({
      name: skill.name,
      toolName: skill.toolName,
      description: skill.description,
      markdownPath: mdPath,
    });
  }

  const manifestPath = path.join(dir, "skills-manifest.json");
  await fs.writeFile(manifestPath, JSON.stringify(entries, null, 2), "utf8");
  process.env.PAPERCLIP_SKILLS_MANIFEST = manifestPath;

  const { registered, handler } = makeMockPi();
  await handler();
  return registered;
}

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */

describe("registerSkillBridge", () => {
  afterEach(() => {
    delete process.env.PAPERCLIP_SKILLS_MANIFEST;
  });

  it("registers one tool per skill with loadMode=essential and empty parameters", async () => {
    const registered = await captureTools([
      {
        name: "Echo Skill",
        toolName: "paperclip_skill_echo_skill",
        description: "Echoes input back",
        markdown: "# Echo Skill\n\nRepeat the user's input.",
      },
      {
        name: "Math Tutor",
        toolName: "paperclip_skill_math_tutor",
        description: "Teaches math concepts",
        markdown: "# Math Tutor\n\nExplains Algebra.",
      },
    ]);

    expect(registered).toHaveLength(2);

    expect(registered[0].name).toBe("paperclip_skill_echo_skill");
    expect(registered[0].label).toBe("Echo Skill");
    expect(registered[0].description).toBe("Echoes input back");
    expect(registered[0].loadMode).toBe("essential");
    expect(registered[0].parameters).toEqual({ type: "object", properties: {} });

    expect(registered[1].name).toBe("paperclip_skill_math_tutor");
    expect(registered[1].label).toBe("Math Tutor");
    expect(registered[1].description).toBe("Teaches math concepts");
    expect(registered[1].loadMode).toBe("essential");
    expect(registered[1].parameters).toEqual({ type: "object", properties: {} });
  });

  it("execute() returns the skill markdown as text content", async () => {
    const registered = await captureTools([
      {
        name: "Test Skill",
        toolName: "paperclip_skill_test",
        description: "A test skill",
        markdown: "# Test Skill\n\nHello world.",
      },
    ]);

    const result = await registered[0].execute();
    expect(result).toEqual({
      content: [{ type: "text", text: "# Test Skill\n\nHello world." }],
    });
  });

  it("re-reads markdown per execute() — staleness guard", async () => {
    const dir = path.join(tmpdir(), `skill-bridge-test-${randomUUID()}`);
    await fs.mkdir(dir, { recursive: true });

    const mdPath = path.join(dir, "stale.md");
    await fs.writeFile(mdPath, "original content", "utf8");

    const manifestPath = path.join(dir, "skills-manifest.json");
    await fs.writeFile(
      manifestPath,
      JSON.stringify([
        {
          name: "Stale Guard",
          toolName: "paperclip_skill_stale",
          description: "Proves re-read",
          markdownPath: mdPath,
        },
      ]),
      "utf8",
    );

    process.env.PAPERCLIP_SKILLS_MANIFEST = manifestPath;
    const { registered, handler } = makeMockPi();
    await handler();

    // First call — original content
    const firstResult = await registered[0].execute();
    expect(firstResult.content[0].text).toBe("original content");

    // Edit the markdown file
    await fs.writeFile(mdPath, "updated content after edit", "utf8");

    // Second call — reflects the edit
    const secondResult = await registered[0].execute();
    expect(secondResult.content[0].text).toBe("updated content after edit");
  });

  it("returns content as {content:[{type:text,text}]} — not a bare string", async () => {
    const registered = await captureTools([
      {
        name: "Shape Check",
        toolName: "paperclip_skill_shape",
        description: "Checks content shape",
        markdown: "some skill text",
      },
    ]);

    const result = await registered[0].execute();
    expect(result).toHaveProperty("content");
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content[0]).toHaveProperty("type", "text");
    expect(result.content[0]).toHaveProperty("text");
  });

  it("no-ops when PAPERCLIP_SKILLS_MANIFEST is unset", async () => {
    delete process.env.PAPERCLIP_SKILLS_MANIFEST;
    const { registered, handler } = makeMockPi();
    await expect(handler()).resolves.toBeUndefined();
    expect(registered).toHaveLength(0);
  });

  it("no-ops when PAPERCLIP_SKILLS_MANIFEST is empty string", async () => {
    process.env.PAPERCLIP_SKILLS_MANIFEST = "";
    const { registered, handler } = makeMockPi();
    await expect(handler()).resolves.toBeUndefined();
    expect(registered).toHaveLength(0);
  });

  it("no-ops when manifest file does not exist", async () => {
    process.env.PAPERCLIP_SKILLS_MANIFEST = "/nonexistent/manifest.json";
    const { registered, handler } = makeMockPi();
    await expect(handler()).resolves.toBeUndefined();
    expect(registered).toHaveLength(0);
  });

  it("no-ops when manifest JSON is not an array", async () => {
    const dir = path.join(tmpdir(), `skill-bridge-test-${randomUUID()}`);
    await fs.mkdir(dir, { recursive: true });
    const manifestPath = path.join(dir, "not-an-array.json");
    await fs.writeFile(manifestPath, JSON.stringify({ not: "an array" }), "utf8");
    process.env.PAPERCLIP_SKILLS_MANIFEST = manifestPath;
    const { registered, handler } = makeMockPi();
    await expect(handler()).resolves.toBeUndefined();
    expect(registered).toHaveLength(0);
  });

  it("skips malformed manifest entries without failing registration", async () => {
    const dir = path.join(tmpdir(), `skill-bridge-test-${randomUUID()}`);
    await fs.mkdir(dir, { recursive: true });

    // Write a manifest with a mix of valid and invalid entries
    await fs.writeFile(
      path.join(dir, "partial.json"),
      JSON.stringify([
        {
          name: "Good",
          toolName: "good",
          description: "d",
          markdownPath: "/tmp/good.md",
        },
        { name: "Bad", description: "no toolName" }, // missing toolName + markdownPath
        "not even an object",
        {
          name: "Also Good",
          toolName: "also_good",
          description: "d",
          markdownPath: "/tmp/also.md",
        },
      ]),
      "utf8",
    );

    process.env.PAPERCLIP_SKILLS_MANIFEST = path.join(dir, "partial.json");
    const { registered, handler } = makeMockPi();
    await handler();

    // Two well-formed entries registered, malformed ones skipped
    expect(registered).toHaveLength(2);
    expect(registered[0].name).toBe("good");
    expect(registered[1].name).toBe("also_good");
  });
});