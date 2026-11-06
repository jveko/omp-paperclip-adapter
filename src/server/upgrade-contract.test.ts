import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { TESTED_OMP_MINORS } from "./acp.js";

/**
 * The published upgrade contract. Paperclip installs this adapter beside an
 * externally managed omp, so two things must not drift silently: the exact
 * engine package it compiles against, and the set of omp lines the version
 * check calls tested. Compatibility with a *surface* is proven by the
 * capability probes at run time; a peer range on the omp binary was a second,
 * weaker gate that went stale the moment a new minor shipped, so it is gone.
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
  it("pins adapter-utils exactly so the execution-target contract cannot drift", () => {
    expect(manifest.dependencies?.[ADAPTER_UTILS]).toBe("2026.1023.0");
  });

  it("declares no omp peer range: the capability probes are the gate", () => {
    expect(manifest.peerDependencies?.[OMP_PACKAGE]).toBeUndefined();
    expect(manifest.peerDependenciesMeta?.[OMP_PACKAGE]).toBeUndefined();
  });

  it("keeps the tested omp lines single-major, ordered and unique", () => {
    expect(TESTED_OMP_MINORS.length).toBeGreaterThan(0);
    const major = TESTED_OMP_MINORS[0].major;
    expect(TESTED_OMP_MINORS.every((m) => m.major === major)).toBe(true);
    const minors = TESTED_OMP_MINORS.map((m) => m.minor);
    expect([...minors].sort((a, b) => a - b)).toEqual(minors);
    expect(new Set(minors).size).toBe(minors.length);
  });
});
