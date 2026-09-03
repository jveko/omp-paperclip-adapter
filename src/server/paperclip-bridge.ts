import { promises as fs } from "node:fs";

/**
 * Paperclip bridge: the adapter's one static omp ExtensionAPI extension, loaded
 * via `--extension <dist/paperclip-bridge.js>`. Today it carries the v0.7
 * lazy-skill lane: on `session_start` it registers one zero-arg
 * `loadMode:"essential"` native tool per enabled Paperclip company skill, and
 * each tool's `execute()` returns the skill's SKILL.md **on demand**, re-reading
 * the file fresh per call so skill content edits land on the next invocation
 * even in a warm session. The v0.8 governance lanes attach to this same
 * extension (their manifest arrives as PAPERCLIP_GOVERNANCE_MANIFEST), which is
 * why the file is not named after skills alone.
 *
 * Self-contained on purpose: runtime imports are node builtins only, so esbuild
 * bundles this file cleanly and omp loads it via dynamic `import()`. The types
 * below are minimal structural mirrors of omp's ToolDefinition/ExtensionAPI
 * (oh-my-pi packages/coding-agent/src/extensibility/extensions/types.ts) — they
 * are erased at build time, not imported.
 */

interface SkillManifestEntry {
  name: string;
  toolName: string;
  description: string;
  markdownPath: string;
}

interface BridgeToolResult {
  content: { type: "text"; text: string }[];
}

/** Structural subset of omp's ToolDefinition. */
interface BridgeTool {
  name: string;
  label: string;
  description: string;
  parameters: { type: "object"; properties: Record<string, never> };
  loadMode: "essential" | "discoverable";
  execute: () => Promise<BridgeToolResult>;
}

/** Structural subset of omp's ExtensionAPI. */
interface BridgePi {
  on(event: "session_start", handler: () => void | Promise<void>): unknown;
  registerTool(tool: BridgeTool): void;
}

function isSkillManifestEntry(value: unknown): value is SkillManifestEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.name === "string" &&
    typeof v.toolName === "string" &&
    typeof v.description === "string" &&
    typeof v.markdownPath === "string"
  );
}

/**
 * Register the paperclip bridge on `pi`. The manifest path is read from
 * `PAPERCLIP_SKILLS_MANIFEST` at `session_start`; when it is unset, unreadable,
 * or unparseable we no-op (no throw) — the bridge also loads in the adapter's
 * side-channel omp children, which never receive the manifest env and must
 * silently skip registration.
 */
export default function registerPaperclipBridge(pi: BridgePi): void {
  pi.on("session_start", async () => {
    const manifestPath = process.env.PAPERCLIP_SKILLS_MANIFEST;
    if (!manifestPath) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    } catch {
      return;
    }
    if (!Array.isArray(parsed)) return;

    for (const value of parsed) {
      if (!isSkillManifestEntry(value)) continue;
      const { name, toolName, description, markdownPath } = value;
      pi.registerTool({
        name: toolName,
        label: name,
        description,
        parameters: { type: "object", properties: {} },
        // "essential" — without it non-builtin tools default to
        // "discoverable" and are stripped from the model's top-level schema.
        loadMode: "essential",
        execute: async () => ({
          content: [
            { type: "text", text: await fs.readFile(markdownPath, "utf8") },
          ],
        }),
      });
    }
  });
}
