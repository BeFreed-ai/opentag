#!/usr/bin/env node
// BeFreed fork only. Runs AFTER `scripts/prepare-cli-release.mjs --channel prod --version <upstream stable>`
// (which keeps all of upstream's identity checks) and BEFORE `pnpm --dir apps/cli build`.
// It changes exactly one thing: the version in apps/cli/package.json becomes `<stable>-befreed.<n>`.
// Usage: node scripts/befreed/set-fork-version.mjs <label> [manifest-path]
import { readFileSync, writeFileSync } from "node:fs";

export const FORK_LABEL = /^(\d+\.\d+\.\d+)-befreed\.([1-9]\d*)$/;

export function setForkVersion(label, manifestPath = "apps/cli/package.json") {
  const match = FORK_LABEL.exec(label);
  if (!match) throw new Error(`label must look like 0.1.4-befreed.1, got "${label}"`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.name !== "open-tag" || manifest.private !== undefined) {
    throw new Error("run scripts/prepare-cli-release.mjs --channel prod first (manifest is not the prod identity)");
  }
  if (manifest.version !== match[1]) {
    throw new Error(`label base ${match[1]} does not match the prepared upstream version ${manifest.version}`);
  }
  manifest.version = label;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const m = setForkVersion(process.argv[2] ?? "", process.argv[3]);
    console.log(`fork version set: ${m.name}@${m.version}`);
  } catch (e) {
    console.error(`[befreed] ${e.message}`);
    process.exit(1);
  }
}
