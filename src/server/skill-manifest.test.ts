import { beforeEach, describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { materializeSkillManifest } from "./skill-manifest.js";

const mocks = vi.hoisted(() => ({
  readPaperclipSkillSyncPreference: vi.fn(),
  readPaperclipRuntimeSkillEntries: vi.fn(),
  resolvePaperclipDesiredSkillNames: vi.fn(),
  readPaperclipSkillMarkdown: vi.fn(),
  listPaperclipSkillEntries: vi.fn(),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", () => mocks);

const MODULE_DIR = "/opt/omp-paperclip-adapter";

function makeEntry(key: string, runtimeName: string, source: string) {
  return { key, runtimeName, source };
}

describe("materializeSkillManifest", () => {
  let dir: string;
  let commitDir: string;
  let triageDir: string;

  beforeEach(async () => {
    mocks.readPaperclipSkillSyncPreference.mockReset();
    mocks.readPaperclipRuntimeSkillEntries.mockReset();
    mocks.resolvePaperclipDesiredSkillNames.mockReset();
    mocks.readPaperclipSkillMarkdown.mockReset();
    mocks.listPaperclipSkillEntries.mockReset();

    dir = path.join(tmpdir(), `skill-manifest-${randomUUID()}`);
    commitDir = path.join(dir, "commit");
    triageDir = path.join(dir, "triage");
    await fs.mkdir(commitDir, { recursive: true });
    await fs.mkdir(triageDir, { recursive: true });
    await fs.writeFile(path.join(commitDir, "SKILL.md"), "# Commit\n\nWrite conventional commits.\n");
    await fs.writeFile(path.join(triageDir, "SKILL.md"), "# Triage\n\nClassify issues.\n");
  });

  it("returns null when no desired skills", async () => {
    mocks.readPaperclipSkillSyncPreference.mockReturnValue({
      explicit: true,
      desiredSkills: [],
      desiredSkillEntries: [],
    });
    const result = await materializeSkillManifest({}, dir, MODULE_DIR);
    expect(result).toBeNull();
    expect(mocks.readPaperclipRuntimeSkillEntries).not.toHaveBeenCalled();
  });

  it("emits only the desired subset when the mount is a superset", async () => {
    mocks.readPaperclipSkillSyncPreference.mockReturnValue({
      explicit: true,
      desiredSkills: ["commit"],
      desiredSkillEntries: [],
    });
    mocks.readPaperclipRuntimeSkillEntries.mockResolvedValue([
      makeEntry("paperclipai/paperclip/commit", "commit", commitDir),
      makeEntry("paperclipai/paperclip/triage", "triage", triageDir),
    ]);
    mocks.resolvePaperclipDesiredSkillNames.mockReturnValue(["paperclipai/paperclip/commit"]);
    mocks.listPaperclipSkillEntries.mockResolvedValue([]);

    const result = await materializeSkillManifest({}, dir, MODULE_DIR);
    expect(result).toBe(path.join(dir, "skills-manifest.json"));
    const manifest = JSON.parse(await fs.readFile(result!, "utf8"));
    expect(manifest).toHaveLength(1);
    expect(manifest[0].name).toBe("commit");
    expect(manifest[0].toolName).toBe("paperclip_skill_commit");
    expect(manifest[0].markdownPath).toBe(path.join(commitDir, "SKILL.md"));
  });

  it("includes a desired key not in the mount via the adapter-local fallback", async () => {
    mocks.readPaperclipSkillSyncPreference.mockReturnValue({
      explicit: true,
      desiredSkills: ["archive"],
      desiredSkillEntries: [],
    });
    mocks.readPaperclipRuntimeSkillEntries.mockResolvedValue([
      makeEntry("paperclipai/paperclip/commit", "commit", commitDir),
    ]);
    mocks.resolvePaperclipDesiredSkillNames.mockReturnValue([
      "paperclipai/paperclip/archive",
    ]);
    mocks.readPaperclipSkillMarkdown.mockResolvedValue("# Archive\n\nMove old items.\n");
    mocks.listPaperclipSkillEntries.mockResolvedValue([
      makeEntry("paperclipai/paperclip/archive", "archive", path.join(dir, "archive")),
    ]);

    const result = await materializeSkillManifest({}, dir, MODULE_DIR);
    expect(result).toBe(path.join(dir, "skills-manifest.json"));
    const manifest = JSON.parse(await fs.readFile(result!, "utf8"));
    expect(manifest).toHaveLength(1);
    expect(manifest[0].name).toBe("archive");
    expect(manifest[0].toolName).toBe("paperclip_skill_archive");
    expect(manifest[0].markdownPath).toBe(path.join(dir, "archive", "SKILL.md"));
  });

  it("sanitizes the toolName from the runtimeName, never the slash-bearing key", async () => {
    const runtimeName = "my skill";
    const source = path.join(dir, "my skill");
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, "SKILL.md"), "# My Skill\n\nDoes a thing.\n");
    mocks.readPaperclipSkillSyncPreference.mockReturnValue({
      explicit: true,
      desiredSkills: [runtimeName],
      desiredSkillEntries: [],
    });
    mocks.readPaperclipRuntimeSkillEntries.mockResolvedValue([
      makeEntry("paperclipai/paperclip/my skill", runtimeName, source),
    ]);
    mocks.resolvePaperclipDesiredSkillNames.mockReturnValue(["paperclipai/paperclip/my skill"]);
    mocks.listPaperclipSkillEntries.mockResolvedValue([]);

    const result = await materializeSkillManifest({}, dir, MODULE_DIR);
    const manifest = JSON.parse(await fs.readFile(result!, "utf8"));
    expect(manifest[0].toolName).toBe("paperclip_skill_my_skill");
    expect(manifest[0].toolName).toMatch(/^paperclip_skill_[A-Za-z0-9_-]{1,64}$/);
    expect(manifest[0].toolName).not.toContain("/");
  });

  it("uses the frontmatter description when present", async () => {
    await fs.writeFile(
      path.join(commitDir, "SKILL.md"),
      "---\ndescription: Write great commits\n---\n# Commit\n\nBody here.\n",
    );
    mocks.readPaperclipSkillSyncPreference.mockReturnValue({
      explicit: true,
      desiredSkills: ["commit"],
      desiredSkillEntries: [],
    });
    mocks.readPaperclipRuntimeSkillEntries.mockResolvedValue([
      makeEntry("paperclipai/paperclip/commit", "commit", commitDir),
    ]);
    mocks.resolvePaperclipDesiredSkillNames.mockReturnValue(["paperclipai/paperclip/commit"]);
    mocks.listPaperclipSkillEntries.mockResolvedValue([]);

    const result = await materializeSkillManifest({}, dir, MODULE_DIR);
    const manifest = JSON.parse(await fs.readFile(result!, "utf8"));
    expect(manifest[0].description).toBe("Write great commits");
  });

  it("falls back to the first non-heading paragraph when there is no frontmatter", async () => {
    mocks.readPaperclipSkillSyncPreference.mockReturnValue({
      explicit: true,
      desiredSkills: ["commit"],
      desiredSkillEntries: [],
    });
    mocks.readPaperclipRuntimeSkillEntries.mockResolvedValue([
      makeEntry("paperclipai/paperclip/commit", "commit", commitDir),
    ]);
    mocks.resolvePaperclipDesiredSkillNames.mockReturnValue(["paperclipai/paperclip/commit"]);
    mocks.listPaperclipSkillEntries.mockResolvedValue([]);

    const result = await materializeSkillManifest({}, dir, MODULE_DIR);
    const manifest = JSON.parse(await fs.readFile(result!, "utf8"));
    expect(manifest[0].description).toBe("Write conventional commits.");
  });

  it("falls back to the runtimeName when the body is empty", async () => {
    await fs.writeFile(path.join(commitDir, "SKILL.md"), "");
    mocks.readPaperclipSkillSyncPreference.mockReturnValue({
      explicit: true,
      desiredSkills: ["commit"],
      desiredSkillEntries: [],
    });
    mocks.readPaperclipRuntimeSkillEntries.mockResolvedValue([
      makeEntry("paperclipai/paperclip/commit", "commit", commitDir),
    ]);
    mocks.resolvePaperclipDesiredSkillNames.mockReturnValue(["paperclipai/paperclip/commit"]);
    mocks.listPaperclipSkillEntries.mockResolvedValue([]);

    const result = await materializeSkillManifest({}, dir, MODULE_DIR);
    const manifest = JSON.parse(await fs.readFile(result!, "utf8"));
    expect(manifest[0].description).toBe("commit");
  });
});