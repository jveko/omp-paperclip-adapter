import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { TESTED_OMP_MINORS } from "./acp.js";

/**
 * The published upgrade contract: Paperclip installs this adapter beside an
 * externally managed omp, so the manifest's peer range is what prevents a
 * silently incompatible build. These assertions read the real manifest rather
 * than restating a constant, and pin the range to the runtime version gate.
 */
const PACKAGE_JSON_PATH = fileURLToPath(new URL("../../package.json", import.meta.url));

const OMP_PACKAGE = "@oh-my-pi/pi-coding-agent";
const ADAPTER_UTILS = "@paperclipai/adapter-utils";

interface PackageManifest {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

let manifest: PackageManifest;

beforeAll(async () => {
  manifest = JSON.parse(await readFile(PACKAGE_JSON_PATH, "utf8")) as PackageManifest;
});

describe("upgrade contract", () => {
  it("pins the omp peer dependency to the tested minors and marks it optional", () => {
    expect(manifest.peerDependencies?.[OMP_PACKAGE]).toBe(">=18.13.0 <18.15.0");
    expect(manifest.peerDependenciesMeta?.[OMP_PACKAGE]?.optional).toBe(true);
  });

  it("pins adapter-utils exactly so the execution-target contract cannot drift", () => {
    expect(manifest.dependencies?.[ADAPTER_UTILS]).toBe("2026.824.1");
  });

  it("keeps the peer range's tested minors in sync with TESTED_OMP_MINORS", () => {
    const range = manifest.peerDependencies?.[OMP_PACKAGE];
    const match =
      typeof range === "string"
        ? /^>=(\d+)\.(\d+)\.(\d+) <(\d+)\.(\d+)\.(\d+)$/.exec(range)
        : null;
    expect(match).not.toBeNull();

    const [, lowerMajor, lowerMinor, lowerPatch, upperMajor, upperMinor, upperPatch] = match!;
    const tested = [...TESTED_OMP_MINORS];
    // A contiguous range is the manifest shape; its ends must be the tested
    // set's ends, so adding or dropping a minor cannot leave a stale peer pin.
    expect(tested.every((m, i) => i === 0 || (m.major === tested[i - 1].major && m.minor === tested[i - 1].minor + 1))).toBe(true);
    const first = tested[0];
    const last = tested[tested.length - 1];
    expect({ major: Number(lowerMajor), minor: Number(lowerMinor) }).toEqual(first);
    expect(Number(lowerPatch)).toBe(0);
    expect(Number(upperMajor)).toBe(last.major);
    expect(Number(upperMinor)).toBe(last.minor + 1);
    expect(Number(upperPatch)).toBe(0);
  });
});
