import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MEMORY_WRITE_LOCK_HOOK_SOURCE,
  MEMORY_WRITE_LOCK_MATCHER,
  memoryWriteLockHooks,
} from "../providers/claude-code/memory-write-lock.js";

let root: string;
let script: string;
let memoryFile: string;
let lock: string;

function run(phase: "pre" | "post", input: unknown, env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [script, phase], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    env: { ...process.env, OPENTAG_MEMORY_LOCK_WAIT_MS: "400", ...env },
    encoding: "utf8",
  });
}

const write = (session: string, file = memoryFile) => ({ session_id: session, tool_input: { file_path: file } });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "memory-lock-test-"));
  script = join(root, "hook.mjs");
  writeFileSync(script, MEMORY_WRITE_LOCK_HOOK_SOURCE);
  const project = join(root, ".claude", "projects", "-some-agent-workspace");
  mkdirSync(join(project, "memory"), { recursive: true });
  memoryFile = join(project, "memory", "MEMORY.md");
  lock = join(project, ".memory-write.lock");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("memory write lock hook", () => {
  it("lets a second session wait, then refuse, while the first holds the lock, and releases on post", () => {
    expect(run("pre", write("a")).status).toBe(0);
    const blocked = run("pre", write("b"));
    expect(blocked.status).toBe(2);
    expect(blocked.stderr).toContain("being written by another session");
    expect(run("pre", write("a")).status).toBe(0); // the owner may write again
    expect(run("post", write("b")).status).toBe(0); // a non-owner cannot release it
    expect(run("pre", write("b")).status).toBe(2);
    expect(run("post", write("a")).status).toBe(0);
    expect(run("pre", write("b")).status).toBe(0);
  });

  it("takes over a lock older than the stale limit", () => {
    expect(run("pre", write("a")).status).toBe(0);
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(lock, old, old);
    expect(run("pre", write("b"), { OPENTAG_MEMORY_LOCK_STALE_MS: "120000" }).status).toBe(0);
  });

  it("never touches writes outside a projects/<project>/memory directory", () => {
    const other = join(root, "notes", "file.md");
    expect(run("pre", write("a", other)).status).toBe(0);
    expect(run("pre", write("b", other)).status).toBe(0);
    const notMemory = join(root, ".claude", "projects", "-some-agent-workspace", "other", "x.md");
    expect(run("pre", write("a", notMemory)).status).toBe(0);
    expect(run("pre", write("b", notMemory)).status).toBe(0);
  });

  it("locks a new file in a memory directory that does not exist yet", () => {
    const fresh = join(root, ".claude", "projects", "-fresh", "memory", "new.md");
    mkdirSync(join(root, ".claude", "projects", "-fresh"), { recursive: true });
    expect(run("pre", write("a", fresh)).status).toBe(0);
    expect(run("pre", write("b", fresh)).status).toBe(2);
  });

  it("allows the tool when its own input is unreadable (fail-open)", () => {
    expect(run("pre", "not json").status).toBe(0);
    expect(run("pre", {}).status).toBe(0);
  });

  it("registers the same script for the pre and post phases of the write tools", () => {
    const hooks = memoryWriteLockHooks("/tmp/a b/hook.mjs", "/usr/local/bin/node");
    expect(hooks.PreToolUse[0]?.matcher).toBe(MEMORY_WRITE_LOCK_MATCHER);
    expect(hooks.PreToolUse[0]?.hooks[0]?.command).toBe('"/usr/local/bin/node" "/tmp/a b/hook.mjs" pre');
    expect(hooks.PostToolUse[0]?.hooks[0]?.command).toBe('"/usr/local/bin/node" "/tmp/a b/hook.mjs" post');
  });
});
