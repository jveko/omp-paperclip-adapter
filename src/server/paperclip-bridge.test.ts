import { afterEach, describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import registerPaperclipBridge from "./paperclip-bridge.js";

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

/** Structural mirror of the omp `tool_call` event the guardrail handler reads. */
interface ToolCallEvent {
  type: "tool_call";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

interface ToolCallContext {
  cwd: string;
}

interface ToolCallResult {
  block?: boolean;
  reason?: string;
  input?: Record<string, unknown>;
}

type GuardrailHandler = (
  event: ToolCallEvent,
  ctx: ToolCallContext,
) => ToolCallResult | undefined | void;

/** Wide enough to hold any subscription the bridge makes. */
type CapturedHandler = (event?: unknown, ctx?: unknown) => unknown;

interface MockPi {
  on(event: "session_start", handler: () => void | Promise<void>): void;
  on(event: "tool_call", handler: GuardrailHandler): void;
  registerTool: (tool: CapturedTool) => void;
}

interface MockPiHandle {
  registered: CapturedTool[];
  /** Subscribed omp event names — lets tests assert lane decoupling. */
  events: () => string[];
  /** Runs the `session_start` handler (the bridge's only async entry point). */
  sessionStart: () => Promise<void>;
  /** Runs the guardrail `tool_call` handler; throws when it was never registered. */
  toolCall: (
    toolName: string,
    input: Record<string, unknown>,
    ctx?: ToolCallContext,
  ) => ToolCallResult | undefined;
  /** Invokes the tool_call subscription with an arbitrary (possibly invalid) payload. */
  toolCallRaw: (event: unknown, ctx: unknown) => unknown;
}

function makeMockPiFull(): MockPiHandle {
  const registered: CapturedTool[] = [];
  const handlers: Record<string, CapturedHandler> = {};
  const pi: MockPi = {
    on(event: string, handler: CapturedHandler) {
      handlers[event] = handler;
    },
    registerTool(tool) {
      registered.push(tool);
    },
  };
  registerPaperclipBridge(pi); // sync — subscribes the lane handlers
  const subscription = (event: string): CapturedHandler | undefined => handlers[event];
  // A function's parameter types are not observable at runtime, so each
  // subscription is narrowed to the event contract it was stored under.
  const guardrail = (): GuardrailHandler => {
    const captured = subscription("tool_call");
    if (!captured) throw new Error("tool_call handler was never registered");
    return captured as GuardrailHandler;
  };
  return {
    registered,
    events: () => Object.keys(handlers),
    sessionStart: async () => {
      await subscription("session_start")?.();
    },
    toolCall(toolName, input, ctx = { cwd: process.cwd() }) {
      const event: ToolCallEvent = {
        type: "tool_call",
        toolCallId: "call-1",
        toolName,
        input,
      };
      return guardrail()(event, ctx) ?? undefined;
    },
    toolCallRaw: (event, ctx) => {
      // Deliberately malformed payloads: the guardrail must not throw on them.
      const call = guardrail() as (event: unknown, ctx: unknown) => unknown;
      return call(event, ctx);
    },
  };
}

/** Skills-lane shim: the v0.7 tests only ever need session_start + registerTool. */
function makeMockPi(): {
  registered: CapturedTool[];
  handler: () => Promise<void>;
} {
  const full = makeMockPiFull();
  return { registered: full.registered, handler: full.sessionStart };
}

/* ------------------------------------------------------------------ */
/*  Fixture helpers                                                    */
/* ------------------------------------------------------------------ */

async function captureTools(
  skills: { name: string; toolName: string; description: string; markdown: string }[],
): Promise<CapturedTool[]> {
  const dir = path.join(tmpdir(), `paperclip-bridge-test-${randomUUID()}`);
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

afterEach(() => {
  delete process.env.PAPERCLIP_SKILLS_MANIFEST;
  delete process.env.PAPERCLIP_GOVERNANCE_MANIFEST;
});

describe("registerPaperclipBridge", () => {
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
    const dir = path.join(tmpdir(), `paperclip-bridge-test-${randomUUID()}`);
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
    const dir = path.join(tmpdir(), `paperclip-bridge-test-${randomUUID()}`);
    await fs.mkdir(dir, { recursive: true });
    const manifestPath = path.join(dir, "not-an-array.json");
    await fs.writeFile(manifestPath, JSON.stringify({ not: "an array" }), "utf8");
    process.env.PAPERCLIP_SKILLS_MANIFEST = manifestPath;
    const { registered, handler } = makeMockPi();
    await expect(handler()).resolves.toBeUndefined();
    expect(registered).toHaveLength(0);
  });

  it("skips malformed manifest entries without failing registration", async () => {
    const dir = path.join(tmpdir(), `paperclip-bridge-test-${randomUUID()}`);
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

/* ------------------------------------------------------------------ */
/*  Governance fixtures                                                */
/* ------------------------------------------------------------------ */

interface GovernanceFixture {
  pi: MockPiHandle;
  /** Manifest file path (so tests can rewrite the policy in place). */
  file: string;
  /** The run's working directory. */
  cwd: string;
  /** The single allowed root for pathScopes tests. */
  root: string;
}

interface GovernanceDirs {
  dir: string;
  cwd: string;
  root: string;
}

/** A policy document, or a builder given the fixture's directories. */
type GovernancePolicyDoc =
  | Record<string, unknown>
  | ((dirs: GovernanceDirs) => Record<string, unknown>);

/**
 * Writes `<tmp>/governance.json` with the policy, points
 * PAPERCLIP_GOVERNANCE_MANIFEST at it, loads the bridge and fires
 * session_start — the shape a governed run child actually sees. Passing
 * `skillToolNames` also materializes a skills manifest, for the coexistence
 * case where one agent runs both lanes.
 */
async function governanceFixture(
  policy: GovernancePolicyDoc,
  skillToolNames: string[] = [],
): Promise<GovernanceFixture> {
  const dir = path.join(tmpdir(), `paperclip-bridge-gov-${randomUUID()}`);
  const cwd = path.join(dir, "work");
  const root = path.join(dir, "sandbox");
  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(root, { recursive: true });

  const file = path.join(dir, "governance.json");
  const doc = typeof policy === "function" ? policy({ dir, cwd, root }) : policy;
  await fs.writeFile(file, JSON.stringify(doc, null, 2), "utf8");
  process.env.PAPERCLIP_GOVERNANCE_MANIFEST = file;

  if (skillToolNames.length > 0) {
    const skillsFile = path.join(dir, "skills-manifest.json");
    await fs.writeFile(
      skillsFile,
      JSON.stringify(
        skillToolNames.map((toolName) => ({
          name: toolName,
          toolName,
          description: `${toolName} skill`,
          markdownPath: path.join(dir, `${toolName}.md`),
        })),
        null,
        2,
      ),
      "utf8",
    );
    for (const toolName of skillToolNames) {
      const markdown = path.join(dir, `${toolName}.md`);
      await fs.writeFile(markdown, `# ${toolName}`, "utf8");
    }
    process.env.PAPERCLIP_SKILLS_MANIFEST = skillsFile;
  }

  const pi = makeMockPiFull();
  await pi.sessionStart();
  return { pi, file, cwd, root };
}

/** Rewrite the manifest in place, rotating mtime so the staleness check fires. */
async function rewriteGovernance(file: string, doc: unknown): Promise<void> {
  const before = await fs.stat(file);
  await fs.writeFile(file, JSON.stringify(doc, null, 2), "utf8");
  const when = new Date(before.mtimeMs + 5_000);
  await fs.utimes(file, when, when);
}

/* ------------------------------------------------------------------ */
/*  Guardrail rules                                                    */
/* ------------------------------------------------------------------ */

describe("governance guardrails (tool_call)", () => {
  it("pathScopes: blocks write outside the allow root, allows inside", async () => {
    const { pi, cwd, root } = await governanceFixture(({ root: allowed }) => ({
      guardrails: { pathScopes: { allow: [allowed] } },
    }));

    const blocked = pi.toolCall("write", { path: path.join(root, "..", "escape.txt"), content: "x" }, { cwd });
    expect(blocked?.block).toBe(true);
    expect(typeof blocked?.reason).toBe("string");
    expect(blocked?.reason?.length).toBeGreaterThan(0);
    expect(blocked?.input).toBeUndefined();

    expect(
      pi.toolCall("write", { path: path.join(root, "ok.txt"), content: "x" }, { cwd }),
    ).toBeUndefined();

    // Relative paths resolve against the run's cwd, so a cwd-relative target
    // inside the root is allowed and one outside it is not.
    expect(pi.toolCall("write", { path: "ok.txt", content: "x" }, { cwd: root })).toBeUndefined();
    expect(pi.toolCall("write", { path: "../out.txt", content: "x" }, { cwd: root })?.block).toBe(true);
  });

  it("pathScopes: with no allow list the run cwd is the implicit root", async () => {
    const { pi, cwd } = await governanceFixture({
      guardrails: { pathScopes: { denyOutside: true } },
    });

    expect(pi.toolCall("write", { path: "src/a.ts" }, { cwd })).toBeUndefined();
    expect(pi.toolCall("edit", { path: "src/a.ts" }, { cwd })).toBeUndefined();
    expect(pi.toolCall("write", { path: "/etc/hosts" }, { cwd })?.block).toBe(true);
  });

  it("pathScopes: guards read and every derived edit path", async () => {
    const { pi, cwd, root } = await governanceFixture(({ root: allowed }) => ({
      guardrails: { pathScopes: { allow: [allowed] } },
    }));

    expect(pi.toolCall("read", { path: path.join(cwd, "secret.env") }, { cwd })?.block).toBe(true);
    expect(pi.toolCall("read", { path: path.join(root, "a.txt") }, { cwd })).toBeUndefined();
    // Hashline edit normalizes to `paths` with more than one target.
    const mixed = pi.toolCall(
      "edit",
      { paths: [path.join(root, "a.txt"), path.join(cwd, "b.txt")] },
      { cwd },
    );
    expect(mixed?.block).toBe(true);
    expect(pi.toolCall("edit", { paths: [path.join(root, "a.txt")] }, { cwd })).toBeUndefined();
    // omp's file tools accept the Claude-style `file_path` alias, so the gate
    // must read it too — otherwise rewording the argument escapes the rail.
    expect(pi.toolCall("write", { file_path: path.join(cwd, "s.txt"), content: "x" }, { cwd })?.block).toBe(true);
    expect(pi.toolCall("write", { file_path: path.join(root, "s.txt"), content: "x" }, { cwd })).toBeUndefined();
  });

  it("pathScopes: a symlinked ancestor into the sandbox still resolves outside", async () => {
    const { pi, cwd, root } = await governanceFixture(({ root: allowed }) => ({
      guardrails: { pathScopes: { allow: [allowed] } },
    }));

    const outside = path.resolve(root, "..", "outside");
    const link = path.join(root, "link");
    await fs.mkdir(outside, { recursive: true });
    try {
      await fs.symlink(outside, link, "dir");
    } catch (err) {
      // Filesystems without symlink rights (or a pre-existing link) cannot
      // exercise the ancestor realpath; skip rather than report a false fail.
      if (err instanceof Error && /EPERM|ENOSYS|EEXIST/.test(err.message)) return;
      throw err;
    }
    expect(pi.toolCall("write", { path: path.join(link, "f.txt"), content: "x" }, { cwd })?.block).toBe(true);
  });

  it("bashDeny: matches whole commands and compound segments", async () => {
    const { pi, cwd } = await governanceFixture({
      guardrails: { bashDeny: ["rm\\s+-rf\\s+/"] },
    });

    expect(pi.toolCall("bash", { command: "rm -rf /" }, { cwd })?.block).toBe(true);
    expect(pi.toolCall("bash", { command: "echo ok && ls" }, { cwd })).toBeUndefined();
    // The dangerous segment is buried in a compound line.
    const compound = pi.toolCall("bash", { command: "cd /tmp; echo hi && rm -rf / --no-preserve-root" }, { cwd });
    expect(compound?.block).toBe(true);
    expect(compound?.reason).toContain("rm\\s+-rf\\s+/");
    // Non-bash tools carry no `command`: the rule cannot fire on them.
    expect(pi.toolCall("write", { path: "rm -rf /", content: "x" }, { cwd })).toBeUndefined();
  });

  it("denyTools: blocks exact tool names only", async () => {
    const { pi, cwd } = await governanceFixture({
      guardrails: { denyTools: ["web_search", "mcp__github__search_prs"] },
    });

    expect(pi.toolCall("web_search", { query: "x" }, { cwd })?.block).toBe(true);
    expect(pi.toolCall("mcp__github__search_prs", {}, { cwd })?.block).toBe(true);
    expect(pi.toolCall("web_search_extra", {}, { cwd })).toBeUndefined();
    expect(pi.toolCall("grep", { pattern: "x" }, { cwd })).toBeUndefined();
  });

  it("control tools are never blocked; task is not a control tool", async () => {
    const { pi, cwd } = await governanceFixture({
      guardrails: {
        denyTools: ["yield", "goal", "think", "todo", "hub", "task"],
        bashDeny: [".*"],
        pathScopes: { allow: ["/forbidden-root"] },
      },
    });

    for (const tool of ["yield", "goal", "think", "todo", "hub"]) {
      expect(pi.toolCall(tool, { command: "rm -rf /", path: "/etc/hosts" }, { cwd })).toBeUndefined();
    }
    // `task` IS subject to the guardrails (it is only special to the T3 budget gate).
    expect(pi.toolCall("task", {}, { cwd })?.block).toBe(true);
  });

  it("argRevisions: merge into the executed args of simple tools", async () => {
    const { pi, cwd } = await governanceFixture({
      guardrails: {
        argRevisions: {
          bash: { timeout: 30 },
          write: { path: "/sandboxed/notes.md" },
        },
      },
    });

    const revised = pi.toolCall("bash", { command: "make", timeout: 600 }, { cwd });
    expect(revised?.block).toBeUndefined();
    expect(revised?.input).toEqual({ command: "make", timeout: 30 });
    expect(
      pi.toolCall("write", { path: "/tmp/x.md", content: "hi" }, { cwd })?.input,
    ).toEqual({ path: "/sandboxed/notes.md", content: "hi" });
    // Untouched tool calls are not revised at all.
    expect(pi.toolCall("read", { path: "/tmp/x.md" }, { cwd })).toBeUndefined();
  });

  it("argRevisions: skipped for hashline edit, whose raw args the event cannot show", async () => {
    const { pi, cwd } = await governanceFixture({
      guardrails: { argRevisions: { edit: { path: "/sandboxed/x" } } },
    });

    // `event.input.path` for edit can be a gate-only derived field; replacing
    // raw execution args from it would corrupt the call, so it is not revised.
    expect(pi.toolCall("edit", { path: "a.ts", input: "PUT 1.=1:\n+x" }, { cwd })).toBeUndefined();
  });

  it("re-reads the manifest when its mtime moves (warm-session staleness)", async () => {
    const { pi, file, cwd } = await governanceFixture({
      guardrails: { denyTools: ["alpha_x"] },
    });

    expect(pi.toolCall("alpha_x", {}, { cwd })?.block).toBe(true);

    // Same byte length: only the mtime fingerprint can reveal the edit.
    await rewriteGovernance(file, { guardrails: { denyTools: ["alpha_y"] } });

    expect(pi.toolCall("alpha_x", {}, { cwd })).toBeUndefined();
    expect(pi.toolCall("alpha_y", {}, { cwd })?.block).toBe(true);
  });

  /* ---------------- decoupling + fail-soft ---------------- */

  it("governance-only run (skillsAsTools off): guardrail is armed without the skills manifest", async () => {
    delete process.env.PAPERCLIP_SKILLS_MANIFEST;
    const { pi, cwd } = await governanceFixture({ guardrails: { denyTools: ["bash"] } });

    expect(pi.events()).toContain("tool_call");
    expect(pi.registered).toHaveLength(0);
    expect(pi.toolCall("bash", { command: "ls" }, { cwd })?.block).toBe(true);
  });

  it("skills-only run: tools register and no guardrail handler is installed", async () => {
    delete process.env.PAPERCLIP_GOVERNANCE_MANIFEST;
    const registered = await captureTools([
      { name: "Solo", toolName: "paperclip_skill_solo", description: "d", markdown: "# Solo" },
    ]);
    expect(registered).toHaveLength(1);

    // And the reverse direction of the decoupling: no `tool_call` subscription.
    const pi = makeMockPiFull();
    await pi.sessionStart();
    expect(pi.events()).not.toContain("tool_call");
    expect(pi.registered).toHaveLength(1);
  });

  it("both lanes coexist on one agent: skills register AND the guardrail blocks", async () => {
    const { pi, cwd } = await governanceFixture(
      { guardrails: { denyTools: ["bash"] } },
      ["paperclip_skill_coexist"],
    );

    expect(pi.registered.map((tool) => tool.name)).toEqual(["paperclip_skill_coexist"]);
    expect((await pi.registered[0].execute()).content[0].text).toBe(
      "# paperclip_skill_coexist",
    );
    expect(pi.toolCall("bash", { command: "ls" }, { cwd })?.block).toBe(true);
  });

  it("no governance manifest: no tool_call subscription, skills lane unaffected", async () => {
    const pi = makeMockPiFull();
    await pi.sessionStart();
    expect(pi.events()).not.toContain("tool_call");

    process.env.PAPERCLIP_GOVERNANCE_MANIFEST = "";
    const blank = makeMockPiFull();
    await blank.sessionStart();
    expect(blank.events()).not.toContain("tool_call");
  });

  it("unreadable or unparseable governance manifest: no handler, no throw", async () => {
    process.env.PAPERCLIP_GOVERNANCE_MANIFEST = "/nonexistent/governance.json";
    const missing = makeMockPiFull();
    await expect(missing.sessionStart()).resolves.toBeUndefined();
    expect(missing.events()).not.toContain("tool_call");

    const dir = path.join(tmpdir(), `paperclip-bridge-gov-${randomUUID()}`);
    await fs.mkdir(dir, { recursive: true });
    const junk = path.join(dir, "governance.json");
    await fs.writeFile(junk, "{not json", "utf8");
    process.env.PAPERCLIP_GOVERNANCE_MANIFEST = junk;
    const junky = makeMockPiFull();
    await junky.sessionStart();
    expect(junky.events()).not.toContain("tool_call");
  });

  it("manifest with no guardrails still arms the handler and allows everything", async () => {
    const { pi, cwd } = await governanceFixture({ budgetCapUsd: 5 });
    expect(pi.events()).toContain("tool_call");
    expect(pi.toolCall("bash", { command: "rm -rf /" }, { cwd })).toBeUndefined();
    expect(pi.toolCall("write", { path: "/etc/hosts", content: "x" }, { cwd })).toBeUndefined();
  });

  it("malformed events and broken rules never throw", async () => {
    const { pi, cwd } = await governanceFixture({
      guardrails: {
        bashDeny: ["(unclosed"],
        denyTools: "not-an-array",
        pathScopes: { allow: ["/tmp"] },
        argRevisions: "nope",
      },
    });

    expect(() => pi.toolCall("bash", { command: "ls" }, { cwd })).not.toThrow();
    expect(() => pi.toolCall("write", {}, { cwd })).not.toThrow();
    expect(() => pi.toolCall("read", { path: 42 }, { cwd })).not.toThrow();
    expect(() => pi.toolCall("edit", { paths: ["a", 7] }, { cwd })).not.toThrow();
    expect(() => pi.toolCallRaw({ toolName: "write" }, undefined)).not.toThrow();
    expect(() => pi.toolCallRaw(undefined, undefined)).not.toThrow();
    expect(() => pi.toolCallRaw({ toolName: "edit", input: null }, { cwd: 7 })).not.toThrow();
  });
});