/**
 * Parallel Local sessions of one Agent share Claude Code's native auto-memory directory
 * (`<claude config>/projects/<project>/memory`). Two sessions writing it at the same moment can
 * overwrite each other, so every memory write is serialized with an atomic `mkdir` lock kept next
 * to the directory. The hook is a plain Node script written into the run's temporary directory and
 * started with the client's own Node, so it needs no Python and no per-machine path.
 *
 * Behavior (the script below): only `Write|Edit|MultiEdit|NotebookEdit` calls whose target is inside a
 * `projects/<project>/memory/` directory are touched; `pre` waits up to 60 seconds for the lock,
 * takes over a lock older than 120 seconds, and refuses the write (exit 2) only after the wait;
 * `post` releases a lock this session owns. Any internal error lets the tool run (fail-open).
 */
export const MEMORY_WRITE_LOCK_MATCHER = "Write|Edit|MultiEdit|NotebookEdit";

export const MEMORY_WRITE_LOCK_HOOK_SOURCE = `import { mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

const WAIT_MS = Number(process.env.OPENTAG_MEMORY_LOCK_WAIT_MS ?? 60000);
const STALE_MS = Number(process.env.OPENTAG_MEMORY_LOCK_STALE_MS ?? 120000);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function resolveReal(path) {
  let current = resolve(path);
  const tail = [];
  for (;;) {
    try {
      return join(realpathSync(current), ...tail.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      tail.push(current.slice(parent.length + 1));
      current = parent;
    }
  }
}

// The project directory is the parent of a "memory" directory that sits directly under "projects".
function memoryProjectDirectory(path) {
  const parts = resolveReal(path).split(sep);
  const at = parts.lastIndexOf("memory");
  if (at < 2 || parts[at - 2] !== "projects") return undefined;
  return parts.slice(0, at).join(sep);
}

function ownerOf(lock) {
  try {
    return readFileSync(join(lock, "owner"), "utf8").trim();
  } catch {
    return undefined;
  }
}

function release(lock) {
  rmSync(lock, { recursive: true, force: true });
}

async function main() {
  const phase = process.argv[2] === "post" ? "post" : "pre";
  const input = JSON.parse(readFileSync(0, "utf8"));
  const toolInput = input.tool_input ?? {};
  const target = toolInput.file_path ?? toolInput.notebook_path ?? "";
  if (!target) return 0;
  const projectDirectory = memoryProjectDirectory(target);
  if (!projectDirectory) return 0;
  const lock = join(projectDirectory, ".memory-write.lock");
  const owner = String(input.session_id ?? "unknown");
  if (phase === "post") {
    if (ownerOf(lock) === owner) release(lock);
    return 0;
  }
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      writeFileSync(join(lock, "owner"), owner);
      return 0;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    if (ownerOf(lock) === owner) return 0;
    try {
      if (Date.now() - statSync(lock).mtimeMs > STALE_MS) {
        release(lock);
        continue;
      }
    } catch {
      continue;
    }
    if (Date.now() > deadline) {
      process.stderr.write("memory/ is being written by another session; retry this write in a moment\\n");
      return 2;
    }
    await sleep(200);
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write("memory write lock hook error (allowing): " + String(error) + "\\n");
    process.exit(0);
  },
);
`;

function shellQuote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** The `hooks` settings entry that serializes memory writes with the script at `scriptPath`. */
export function memoryWriteLockHooks(scriptPath: string, nodePath: string = process.execPath) {
  const command = (phase: "pre" | "post") => ({
    type: "command",
    command: `${shellQuote(nodePath)} ${shellQuote(scriptPath)} ${phase}`,
  });
  return {
    PreToolUse: [{ matcher: MEMORY_WRITE_LOCK_MATCHER, hooks: [command("pre")] }],
    PostToolUse: [{ matcher: MEMORY_WRITE_LOCK_MATCHER, hooks: [command("post")] }],
  };
}
