import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

/**
 * omp's named profiles, used by `sessionScope: "profile"`.
 *
 * A named profile is a config root of its own (`<home>/<PI_CONFIG_DIR or
 * .omp>/profiles/<name>`, dirs.ts:115-122), chosen by `OMP_PROFILE`. It is NOT
 * under the Paperclip instance root: omp joins PI_CONFIG_DIR as a NAME under
 * `os.homedir()`, so instance-root placement is impossible. The isolation this
 * buys is omp's own (its session, config and credential stores all resolve
 * under the profile), not the adapter's.
 *
 * Names are derived per agent, sanitized to omp's own grammar and capped at 64
 * chars. A raw name that has to be rewritten or truncated keeps a short hash of
 * the original, so two agents can never collapse onto one profile.
 */

export const PROFILE_NAME_MAX = 64;

/** omp's profile grammar (dirs.ts:42): lowercase, 1-64, must start alnum. */
const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Names Windows treats as devices; omp refuses them as profile directories. */
const WINDOWS_RESERVED_RE = /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/i;

/** Paperclip's instance-id grammar (adapter-utils server-utils PATH_SEGMENT_RE). */
const INSTANCE_ID_RE = /^[a-zA-Z0-9_-]+$/;

export interface AgentIds {
  instanceId: string;
  companyId: string;
  agentId: string;
}

/**
 * Why a name omp would refuse cannot be used: null when it is valid, else the
 * operator-facing reason. `default` means "no profile" to omp, so it can never
 * name one.
 */
export function validateProfileName(name: string): string | null {
  if (name === "") return "an omp profile name cannot be empty";
  if (name === "default") return "'default' selects omp's unnamed profile, not a named one";
  if (name === "." || name === ".." || name.endsWith(".")) {
    return `'${name}' is not a usable directory name`;
  }
  if (!PROFILE_NAME_RE.test(name)) {
    return `'${name}' must match ${PROFILE_NAME_RE.source} (lowercase letters, digits, '.', '_' and '-', at most ${PROFILE_NAME_MAX} characters, starting with a letter or digit)`;
  }
  if (WINDOWS_RESERVED_RE.test(name)) return `'${name}' is a reserved device name on Windows`;
  
  return null;
}

/**
 * Rewrite arbitrary text into a valid profile name. A name already in omp's
 * grammar is returned unchanged (so stable ids stay readable); anything else
 * gets a short hash of the original, which keeps uppercase, punctuation and
 * truncation from merging two different agents onto one profile.
 */
export function sanitizeAgentProfileName(raw: string): string {
  const trimmed = raw.trim();
  const cleaned = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[-.]+$/, "");
  if (cleaned === trimmed && PROFILE_NAME_RE.test(cleaned)) return cleaned;
  const suffix = `-${createHash("sha256").update(trimmed).digest("hex").slice(0, 8)}`;
  const room = PROFILE_NAME_MAX - suffix.length;
  let prefix = cleaned.length <= room ? cleaned : cleaned.slice(0, room);
  prefix = prefix.replace(/[-.]+$/, "");
  if (prefix === "" || !/^[a-z0-9]/.test(prefix)) prefix = "agent";
  return `${prefix}${suffix}`;
}

/** The stable profile name for one agent: `pc-<instance>-<company>-<agent>`. */
export function agentProfileName(ids: AgentIds): string {
  return sanitizeAgentProfileName(`pc-${ids.instanceId}-${ids.companyId}-${ids.agentId}`);
}

/**
 * The active Paperclip instance id, or a throw the caller turns into a typed
 * refusal. Same grammar the instance-root resolver enforces.
 */
export function adapterInstanceId(): string {
  const id = process.env.PAPERCLIP_INSTANCE_ID?.trim() || "default";
  if (!INSTANCE_ID_RE.test(id)) {
    throw new Error(`invalid PAPERCLIP_INSTANCE_ID '${id}': a profile name cannot be derived from it`);
  }
  return id;
}

/** `$HOME/<PI_CONFIG_DIR|.omp>/profiles/<name>` — exactly where omp resolves it. */
export function profileConfigRoot(name: string): string {
  return path.join(os.homedir(), process.env.PI_CONFIG_DIR || ".omp", "profiles", name);
}

/** The agent dir inside a profile root; omp's sessions and stores live here. */
export function profileAgentDir(name: string): string {
  return path.join(profileConfigRoot(name), "agent");
}
