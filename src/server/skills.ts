import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  readPaperclipRuntimeSkillEntries,
  readPaperclipSkillMarkdown,
  readPaperclipSkillSyncPreference,
  resolvePaperclipDesiredSkillNames,
  buildRuntimeMountedSkillSnapshot,
} from "@paperclipai/adapter-utils/server-utils";
import type { AdapterSkillContext, AdapterSkillSnapshot } from "@paperclipai/adapter-utils";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
export const skillsDir = path.resolve(moduleDir, "../..", ".omp-adapter-skills");

// Bounded per-process cache keyed by `${outputDir}:${sha256}`. Entries that
// fall out of the cache leave orphaned `instructions-*.md` behind; they are
// inert and safe to wipe wholesale on reinstall.
const skillsCache = new Map<string, string>();
const SKILLS_CACHE_MAX = 50;

export interface SkillMarkdownSource {
  key: string;
  markdown: string;
}

export async function buildSkillsInstructions(
  skills: SkillMarkdownSource[],
  existingInstructionsPath: string | null,
  outputDir: string = skillsDir,
): Promise<string | null> {
  if (skills.length === 0 && !existingInstructionsPath) return null;
  const sections: string[] = [];
  if (skills.length > 0) {
    sections.push(`# Skills\n\n${skills.map((s) => s.markdown.trim()).join("\n\n")}\n`);
  }
  if (existingInstructionsPath) {
    // A stale/unreadable user instructions file degrades gracefully: build the
    // skills-only file rather than aborting the run.
    const existing = await fs.readFile(existingInstructionsPath, "utf8").catch(() => null);
    if (existing) sections.push(existing);
  }
  const combined = sections.join("\n\n");
  const hash = createHash("sha256").update(combined).digest("hex").slice(0, 16);
  const cacheKey = `${outputDir}:${hash}`;
  const cached = skillsCache.get(cacheKey);
  if (cached) {
    const exists = await fs.stat(cached).then((s) => s.isFile()).catch(() => false);
    if (exists) return cached;
    skillsCache.delete(cacheKey);
  }
  // A read-only output dir (e.g. a read-only package install) must not abort
  // the run: skip injection rather than throw.
  try {
    await fs.mkdir(outputDir, { recursive: true });
    const target = path.join(outputDir, `instructions-${hash}.md`);
    await fs.writeFile(target, combined, "utf8");
    skillsCache.set(cacheKey, target);
    if (skillsCache.size > SKILLS_CACHE_MAX) {
      const oldest = skillsCache.keys().next().value;
      if (oldest !== undefined) skillsCache.delete(oldest);
    }
    return target;
  } catch {
    return null;
  }
}

export async function listOmpSkillsSnapshot(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  const entries = await readPaperclipRuntimeSkillEntries(ctx.config, moduleDir);
  // Canonicalized names (runtime-name/slug references resolved to keys) so the
  // reported desired set matches what syncOmpSkills reflects.
  const names = resolvePaperclipDesiredSkillNames(ctx.config, entries);
  return buildRuntimeMountedSkillSnapshot({
    adapterType: ctx.adapterType,
    availableEntries: entries,
    desiredSkills: names,
    configuredDetail: "Injected into the run prompt on cold-start heartbeats; warm-resume runs keep prior context.",
  });
}

export async function syncOmpSkills(
  ctx: AdapterSkillContext,
  desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  const entries = await readPaperclipRuntimeSkillEntries(ctx.config, moduleDir);
  // The server persists the preference before calling syncSkills (codex
  // pattern), so the persisted config already mirrors the passed request.
  // Canonicalizing the passed array — not the config — keeps the hook honest
  // about what it was asked to sync.
  const names = resolvePaperclipDesiredSkillNames(
    { ...ctx.config, paperclipSkillSync: { desiredSkills } },
    entries,
  );
  return buildRuntimeMountedSkillSnapshot({
    adapterType: ctx.adapterType,
    availableEntries: entries,
    desiredSkills: names,
    configuredDetail: "Injected into the run prompt on cold-start heartbeats; warm-resume runs keep prior context.",
  });
}
