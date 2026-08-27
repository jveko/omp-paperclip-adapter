import { beforeEach, describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { buildSkillsInstructions } from "./skills.js";

const FIXTURE_SKILLS = [
  { key: "commit", markdown: "# Commit\n\nWrite conventional commits.\n" },
  { key: "triage", markdown: "# Triage\n\nClassify issues.\n" },
];

describe("buildSkillsInstructions", () => {
  let tmp: string;
  let userFile: string;

  beforeEach(async () => {
    tmp = path.join(tmpdir(), `skills-test-${randomUUID()}`);
    await fs.mkdir(tmp, { recursive: true });
    userFile = path.join(tmp, "user-instructions.md");
    await fs.writeFile(userFile, "# User instructions\n\nFollow the rules.\n");
  });

  it("concatenates skill markdown into a skills section", async () => {
    const file = await buildSkillsInstructions(FIXTURE_SKILLS, null, tmp);
    expect(file).toBeTruthy();
    const content = await fs.readFile(file!, "utf8");
    expect(content).toContain("# Skills");
    expect(content).toContain("# Commit\n\nWrite conventional commits.");
    expect(content).toContain("# Triage\n\nClassify issues.");
  });

  it("appends existing instructions file content after the skills section", async () => {
    const file = await buildSkillsInstructions(FIXTURE_SKILLS, userFile, tmp);
    expect(file).toBeTruthy();
    const content = await fs.readFile(file!, "utf8");
    const skillsIdx = content.indexOf("# Skills");
    const userIdx = content.indexOf("# User instructions");
    expect(skillsIdx).toBeGreaterThanOrEqual(0);
    expect(userIdx).toBeGreaterThan(skillsIdx);
  });

  it("returns null when no skills and no existing file", async () => {
    const file = await buildSkillsInstructions([], null, tmp);
    expect(file).toBeNull();
  });

  it("reuses the cached file for identical content and writes a new one on change", async () => {
    const first = await buildSkillsInstructions(FIXTURE_SKILLS, null, tmp);
    const second = await buildSkillsInstructions(FIXTURE_SKILLS, null, tmp);
    expect(second).toBe(first);
    const changed = await buildSkillsInstructions(
      [{ key: "commit", markdown: "# Commit\n\nUpdated.\n" }],
      null,
      tmp,
    );
    expect(changed).not.toBe(first);
    const files = await fs.readdir(tmp);
    const instructionFiles = files.filter((f) => f.startsWith("instructions-"));
    expect(instructionFiles).toHaveLength(2);
  });

  it("still materializes the skills section when the user file is unreadable", async () => {
    const missing = path.join(tmp, "missing-user.md");
    const file = await buildSkillsInstructions(FIXTURE_SKILLS, missing, tmp);
    expect(file).toBeTruthy();
    const content = await fs.readFile(file!, "utf8");
    expect(content).toContain("# Skills");
    expect(content).not.toContain("# User instructions");
  });
});
