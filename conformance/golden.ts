import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";

/**
 * Golden-file support for the conformance harness.
 *
 * A golden holds the normalized facts a run produced: the event order, the
 * usage/cost fields, the session-reuse pattern, the lease outcome and the
 * capability diagnostics. Volatile values (run ids, pids, timestamps, session
 * ids, temp paths) are replaced before comparison, so a diff is a behaviour
 * change, not noise — that diff is the release note.
 *
 * Regenerate deliberately: `UPDATE_CONFORMANCE_GOLDEN=1 npm run test:conformance`.
 */

const GOLDEN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "golden");

/**
 * Replace volatile strings the run generates, in one pass per key. The shape is
 * preserved, so the caller's type travels through.
 */
export function normalizeGolden<T>(value: T, replacements: Record<string, string>): T {
  if (typeof value === "string") {
    let out: string = value;
    for (const [pattern, token] of Object.entries(replacements)) {
      out = out.replaceAll(pattern, token);
    }
    return out as unknown as T;
  }
  if (Array.isArray(value)) return value.map((entry) => normalizeGolden(entry, replacements)) as T;
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .map(([key, entry]) => [replacements[key] ?? key, normalizeGolden(entry, replacements)])
        // Volatile keys are dropped, not normalized to a token: a key that can
        // appear or vanish per run must not turn into a diff.
        .filter(([key]) => key !== ""),
    ) as T;
  }
  return value;
}

/** The replacements every profile uses. */
export function runReplacements(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "/tmp/omp-conformance-": "<tmp>/",
    ...extra,
  };
}

export async function checkGolden(name: string, actual: unknown): Promise<void> {
  const file = path.join(GOLDEN_DIR, `${name}.json`);
  if (process.env.UPDATE_CONFORMANCE_GOLDEN === "1") {
    await mkdir(GOLDEN_DIR, { recursive: true });
    await writeFile(file, `${JSON.stringify(actual, null, 2)}\n`, "utf8");
    return;
  }
  const golden: unknown = JSON.parse(await readFile(file, "utf8"));
  expect(actual).toEqual(golden);
}

/**
 * The event order, reduced to what the board acts on: the kind and level.
 * Engine phase timings and payloads are deliberately out of the golden — they
 * are per-run measurements, and the adapter owns the kinds, not the numbers.
 */
export function eventKinds(events: ReadonlyArray<{ eventType: string; level?: string }>): string[] {
  return events.map((event) => `${event.eventType}:${event.level ?? "info"}`);
}
