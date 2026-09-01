import { promises as fs } from "node:fs";
import path from "node:path";
import {
  listPaperclipSkillEntries,
  readPaperclipRuntimeSkillEntries,
  readPaperclipSkillMarkdown,
  readPaperclipSkillSyncPreference,
  resolvePaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";

export interface SkillManifestEntry {
  name: string;
  toolName: string;
  description: string;
  markdownPath: string;
}

/**
 * Replace any character not in [A-Za-z0-9_-] with '_' so the derived tool
 * name never carries '/' (provider tool-name rules allow only
 * ^[a-zA-Z0-9_-]{1,64}$; a slash 400s every request in the session).
 * Exported as a test seam.
 */
export function sanitizeSkillToolName(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_");
}

/**
 * Derive a human-readable description from a skill's SKILL.md: the frontmatter
 * `description:` value when present, else the first non-heading, non-blank
 * paragraph of the body, else the runtime name. Real skills carry no
 * frontmatter, so the paragraph fallback is the path that actually runs.
 */
export function describeSkill(markdown: string, runtimeName: string): string {
  const trimmed = markdown.trim();
  if (trimmed.startsWith("---")) {
    const end = trimmed.indexOf("\n---", 3);
    if (end !== -1) {
      const front = trimmed.slice(0, end).split("\n");
      const descLine = front
        .map((line) => line.trim())
        .find((line) => /^description\s*:/i.test(line));
      if (descLine) {
        const value = descLine
          .replace(/^description\s*:\s*/i, "")
          .trim()
          .replace(/^["']|["']$/g, "");
        if (value) return value;
      }
    }
  }
  const paragraph: string[] = [];
  for (const line of trimmed.split("\n")) {
    const text = line.trim();
    if (!text) {
      if (paragraph.length > 0) break;
      continue;
    }
    if (text.startsWith("#")) continue;
    paragraph.push(text);
  }
  if (paragraph.length > 0) return paragraph.join(" ");
  return runtimeName;
}

/**
 * Materialize the skills manifest for the lazy-skill bridge.
 *
 * Mirrors materializeSkillsInstructions' selection EXACTLY: only user-desired
 * skills (resolved to keys) are emitted — never the whole mount — with a
 * fallback to the adapter-bundled skills dir for a desired key absent from
 * the runtime mount. Emits { name, toolName, description, markdownPath } and
 * writes the JSON array to dir/skills-manifest.json. Returns null when no
 * skill is desired or none could be resolved.
 */
export async function materializeSkillManifest(
  config: Record<string, unknown>,
  dir: string,
  moduleDir: string,
): Promise<string | null> {
  const preference = readPaperclipSkillSyncPreference(config);
  if (preference.desiredSkills.length === 0) return null;

  const entries = await readPaperclipRuntimeSkillEntries(config, moduleDir);
  const desiredKeys = resolvePaperclipDesiredSkillNames(config, entries);
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));

  // Resolve the fallback path the same way readPaperclipSkillMarkdown does
  // internally (scan the adapter package's own skills dir).
  const localEntries = await listPaperclipSkillEntries(moduleDir);
  const localByKey = new Map(localEntries.map((entry) => [entry.key, entry]));

  const manifest: SkillManifestEntry[] = [];
  for (const key of desiredKeys) {
    const entry = byKey.get(key);
    let markdown: string | null = null;
    let markdownPath: string | null = null;

    if (entry) {
      markdownPath = path.join(entry.source, "SKILL.md");
      markdown = await fs.readFile(markdownPath, "utf8").catch(() => null);
    }
    if (markdown === null) {
      const fallback = await readPaperclipSkillMarkdown(moduleDir, key);
      const localEntry = localByKey.get(key);
      if (fallback && localEntry) {
        markdown = fallback;
        markdownPath = path.join(localEntry.source, "SKILL.md");
      }
    }
    if (markdown === null || markdownPath === null) continue;

    const runtimeName = entry?.runtimeName ?? key.split("/").pop() ?? key;
    manifest.push({
      name: runtimeName,
      toolName: `paperclip_skill_${sanitizeSkillToolName(runtimeName)}`.slice(0, 64),
      description: describeSkill(markdown, runtimeName),
      markdownPath,
    });
  }
  if (manifest.length === 0) return null;

  const manifestPath = path.join(dir, "skills-manifest.json");
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  return manifestPath;
}