#!/usr/bin/env node
// Publish one package unless that exact version is already on npm. Release
// re-runs are common after a partial failure, and rebuilding over a version
// that already shipped must never push different bytes.
//
// Usage: node scripts/release/publish.mjs <package-dir> [--dry-run]

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const packageArg = argv.find((arg) => !arg.startsWith("--")) ?? ".";
const packageDir = path.resolve(packageArg);

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) fail(`${command} could not start: ${result.error.message}`);
  if (result.status !== 0) process.exit(result.status ?? 1);
  return result;
}

const manifest = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"));
const { name, version } = manifest;
if (typeof name !== "string" || typeof version !== "string") {
  fail(`${packageDir}/package.json must set both name and version`);
}

const distTag = version.includes("-") ? "next" : "latest";

const probe = spawnSync("npm", ["view", `${name}@${version}`, "version", "--json"], {
  encoding: "utf8",
});
if (probe.status === 0 && probe.stdout.trim() !== "") {
  console.log(`${name}@${version} is already published; skipping`);
  process.exit(0);
}
if (probe.status !== 0) {
  const output = `${probe.stdout ?? ""}${probe.stderr ?? ""}`;
  // The registry reports an unpublished package or version as 404; anything
  // else (auth, network, registry outage) must stop the release.
  if (!/E404|404 Not Found/.test(output)) {
    console.error(output.trim());
    fail(`could not query the registry for ${name}@${version}`);
  }
}

const publishArgs = ["publish", packageDir, "--tag", distTag];
if (dryRun) publishArgs.push("--dry-run");
else publishArgs.push("--provenance", "--access", "public");

console.log(`${dryRun ? "[dry-run] " : ""}publishing ${name}@${version} (dist-tag: ${distTag})`);
run("npm", publishArgs);
