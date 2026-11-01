import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setForkVersion } from "../befreed/set-fork-version.mjs";
import { validateChannelVersion } from "../portable/build-portable.mjs";

test("prod channel accepts a -befreed.<n> label, still rejects other prereleases", () => {
  validateChannelVersion("prod", "0.1.4-befreed.1");
  validateChannelVersion("prod", "0.1.4");
  assert.throws(() => validateChannelVersion("prod", "0.1.4-befreed.0"));
  assert.throws(() => validateChannelVersion("prod", "0.1.4-befreed"));
  assert.throws(() => validateChannelVersion("prod", "0.1.4-mcpfix.1"));
  assert.throws(() => validateChannelVersion("staging", "0.1.4-befreed.1"));
});

function manifest(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "befreed-"));
  const path = join(dir, "package.json");
  writeFileSync(path, JSON.stringify({ name: "open-tag", version: "0.1.4", ...overrides }));
  return path;
}

test("setForkVersion rewrites only the version, and only on a prepared prod manifest", () => {
  const path = manifest();
  setForkVersion("0.1.4-befreed.2", path);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).version, "0.1.4-befreed.2");
  assert.throws(() => setForkVersion("0.1.5-befreed.1", manifest()), /does not match/);
  assert.throws(() => setForkVersion("0.1.4", manifest()), /label must look like/);
  assert.throws(() => setForkVersion("0.1.4-befreed.1", manifest({ private: true })), /prepare-cli-release/);
});
