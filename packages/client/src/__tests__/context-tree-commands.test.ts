import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONTEXT_TREE_COMMAND_WORKER_SOURCE } from "../runner/context-tree-command-worker.js";
import { resolveContextTreePackage, runContextTreeCli } from "../runtime/context-tree.js";
import {
  CONTEXT_TREE_COMMAND_CLIENT_SOURCE,
  ContextTreeCommandGateway,
  requestContextTreeCommand,
} from "../runtime/context-tree-commands.js";
import { configureContextTrees } from "../runtime/context-tree-connections.js";
import { type RuntimeCredentialRelay, RuntimeCredentialRelayError } from "../runtime/runtime-credential-relay.js";

const executeFile = promisify(execFile);
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const source = { kind: "git", repository: "acme/project", path: "docs", ref: "main" } as const;
function parent() {
  const controller = new AbortController();
  const close = vi.fn(async () => undefined);
  const child = { localHandleFor: () => "tree-local-handle", close };
  const openContextTree = vi.fn(async () => child);
  return {
    controller,
    close,
    openContextTree,
    relay: { signal: controller.signal, openContextTree } as unknown as RuntimeCredentialRelay,
  };
}
async function directory() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ot-tree-command-test-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

describe("Context Tree command boundary", () => {
  it("returns a TIMEOUT result when a managed sync request is aborted", async () => {
    const root = await directory();
    const owner = parent();
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gateway = new ContextTreeCommandGateway({
      parent: owner.relay,
      sources: [source],
      workspace: root,
      stateDirectory: join(root, "private"),
      environment: () => ({}),
      execute: async (_args, _environment, signal) => {
        started();
        return new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    });
    await gateway.listen("tcp");
    cleanups.push(() => gateway.close());
    const controller = new AbortController();
    const result = runContextTreeCli({ root, cliPath: "unused", skillsPath: root }, ["sync"], {
      env: { OPENTAG_CONTEXT_TREE_URL: `http://127.0.0.1:${gateway.port}` },
      signal: controller.signal,
    });
    const checked = expect(result).resolves.toEqual({ payload: undefined, failureCode: "TIMEOUT" });
    await running;
    controller.abort();
    await checked;
  });

  it.each(["internal", "visible"])("preserves standalone commands in a legacy %s Session", async (kind) => {
    const root = await directory();
    const client = join(root, "client.mjs");
    const cli = join(root, "standalone.mjs");
    await writeFile(client, CONTEXT_TREE_COMMAND_CLIENT_SOURCE);
    await writeFile(cli, "process.stdout.write(process.argv.slice(2).join(' '));");
    const environment = {
      HOME: root,
      OPENTAG_HOME: root,
      ...(kind === "visible" ? { OPENTAG_PROVIDER_ENV_FILE: join(root, "provider.sh") } : {}),
    };
    for (const args of [
      ["sync", "--offline"],
      ["write", "prepare"],
      ["write", "finish", "retained-session"],
      ["write", "abort", "retained-session"],
    ]) {
      expect((await executeFile(process.execPath, [client, cli, ...args], { env: environment })).stdout).toBe(
        args.join(" "),
      );
    }
  });

  it.each(["absent", "missing", "invalid", "empty"])(
    "does not invoke the standalone CLI in proxy mode with manifest state %s",
    async (manifestState) => {
      const root = await directory();
      const client = join(root, "client.mjs");
      const cli = join(root, "standalone.mjs");
      const marker = join(root, "invoked");
      const manifest = join(root, "current.json");
      await writeFile(client, CONTEXT_TREE_COMMAND_CLIENT_SOURCE);
      await writeFile(
        cli,
        `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'invoked');`,
      );
      if (manifestState === "invalid") await writeFile(manifest, "not JSON");
      if (manifestState === "empty") await writeFile(manifest, JSON.stringify({ environment: {} }));
      for (const args of [
        ["sync", "--offline"],
        ["write", "prepare"],
      ])
        await expect(
          executeFile(process.execPath, [client, cli, ...args], {
            env: {
              OPENTAG_CONTEXT_TREE_MANAGED: "1",
              ...(manifestState === "absent" ? {} : { OPENTAG_CONTEXT_TREE_MANIFEST: manifest }),
            },
          }),
        ).rejects.toMatchObject({ stderr: expect.stringContaining("Context Tree execution unavailable") });
      await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("keeps local reads and verification available during proxy routing loss", async () => {
    const root = await directory();
    const client = join(root, "client.mjs");
    const cli = join(root, "standalone.mjs");
    await writeFile(client, CONTEXT_TREE_COMMAND_CLIENT_SOURCE);
    await writeFile(cli, "process.stdout.write(process.argv.slice(2).join(' '));");
    for (const command of ["read", "verify"])
      expect(
        (
          await executeFile(process.execPath, [client, cli, command], {
            env: { OPENTAG_CONTEXT_TREE_MANAGED: "1", OPENTAG_CONTEXT_TREE_MANIFEST: join(root, "missing.json") },
          })
        ).stdout,
      ).toBe(command);
    for (const args of [
      ["sync", "--offline"],
      ["write", "prepare"],
    ])
      expect((await executeFile(process.execPath, [client, cli, ...args], { env: {} })).stdout).toBe(args.join(" "));
    await expect(
      executeFile(process.execPath, [client, cli, "sync"], {
        env: { OPENTAG_CONTEXT_TREE_MANIFEST: join(root, "missing.json") },
      }),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("Context Tree execution unavailable") });
  });

  it("rejects arbitrary commands, foreign projects and ambiguous selectors before obtaining credentials", async () => {
    const root = await directory();
    const owner = parent();
    const execute = vi.fn();
    const gateway = new ContextTreeCommandGateway({
      parent: owner.relay,
      sources: [source],
      workspace: root,
      stateDirectory: join(root, "state"),
      environment: () => ({}),
      execute,
    });
    for (const args of [
      ["git", "push"],
      ["connect", "other/repo"],
      ["sync", "--project-path", "/foreign"],
      ["sync", "--tree", "foreign/repo"],
      ["write", "finish", "../session"],
    ])
      await expect(gateway.run(args)).rejects.toThrow();
    expect(owner.openContextTree).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("issues a credential only for the selected CLI child and closes it after failure", async () => {
    const root = await directory();
    const owner = parent();
    const execute = vi.fn(
      async (_args: readonly string[], environment: Readonly<Record<string, string | undefined>>) => {
        expect(environment.GH_TOKEN).toBe("tree-local-handle");
        expect(environment.OPENTAG_CONTEXT_TREE_SOCKET).toBeUndefined();
        expect(environment.GITHUB_TOKEN).toBeUndefined();
        throw new Error("interrupted");
      },
    );
    const gateway = new ContextTreeCommandGateway({
      parent: owner.relay,
      sources: [source],
      workspace: root,
      stateDirectory: join(root, "state"),
      environment: () => ({ OPENTAG_CONTEXT_TREE_SOCKET: "parent.sock", GITHUB_TOKEN: "ambient" }),
      execute,
    });
    await expect(gateway.run(["sync"])).rejects.toThrow("interrupted");
    expect(owner.openContextTree).toHaveBeenCalledWith(source, expect.any(AbortSignal));
    expect(owner.close).toHaveBeenCalledOnce();
    expect(gateway.relay).toBeUndefined();
    owner.controller.abort();
    await expect(gateway.run(["sync"])).rejects.toThrow("unavailable");
  });

  it.each(["caller", "parent", "close"])(
    "cancels the private CLI on %s loss and releases the child",
    async (reason) => {
      const root = await directory();
      const owner = parent();
      const caller = new AbortController();
      let started!: () => void;
      const ready = new Promise<void>((done) => {
        started = done;
      });
      const gateway = new ContextTreeCommandGateway({
        parent: owner.relay,
        workspace: root,
        sources: [source],
        stateDirectory: join(root, "state"),
        environment: () => ({}),
        execute: async (_args, _environment, signal) => {
          started();
          await new Promise<void>((_done, reject) =>
            signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }),
          );
          return { code: 0, stdout: "{}", stderr: "" };
        },
      });
      const operation = gateway.run(["sync"], caller.signal);
      const rejected = expect(operation).rejects.toThrow("cancelled");
      await ready;
      if (reason === "caller") caller.abort();
      if (reason === "parent") owner.controller.abort();
      if (reason === "close") await gateway.close();
      await rejected;
      expect(owner.close).toHaveBeenCalledOnce();
      await gateway.close();
    },
  );

  it("bounds concurrent operations and does not replay a failed write", async () => {
    const root = await directory();
    const owner = parent();
    let release!: () => void;
    const execute = vi.fn(async () => {
      await new Promise<void>((done) => {
        release = done;
      });
      return { code: 1, stdout: "{}", stderr: "unknown" };
    });
    const gateway = new ContextTreeCommandGateway({
      parent: owner.relay,
      sources: [source],
      workspace: root,
      stateDirectory: join(root, "state"),
      environment: () => ({}),
      execute,
    });
    const first = gateway.run(["sync"]);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    await expect(gateway.run(["sync"])).rejects.toThrow("unavailable");
    release();
    await first;
    expect(execute).toHaveBeenCalledOnce();
  });

  it("aborts in-flight gateway command when the HTTP client times out and recovers offline", async () => {
    const root = await directory();
    const pack = resolveContextTreePackage();
    if (!pack) throw new Error("Missing pinned CLI");
    const owner = parent();
    const calls: string[][] = [];
    let abortedOnline = false;
    const gateway = new ContextTreeCommandGateway({
      parent: owner.relay,
      sources: [source],
      workspace: root,
      stateDirectory: join(root, "state"),
      environment: () => ({}),
      execute: async (args, _environment, signal) => {
        calls.push([...args]);
        if (!args.includes("--offline")) {
          await new Promise<void>((resolve) => {
            signal.addEventListener(
              "abort",
              () => {
                abortedOnline = true;
                resolve();
              },
              { once: true },
            );
          });
          throw new Error("aborted online sync");
        }
        return {
          code: 0,
          stdout: JSON.stringify({ schemaVersion: 3, connections: [] }),
          stderr: "",
        };
      },
    });
    await gateway.listen("tcp");
    cleanups.push(() => gateway.close());
    const env = { OPENTAG_CONTEXT_TREE_URL: `http://127.0.0.1:${gateway.port}` };
    const timedOut = await runContextTreeCli(pack, ["sync"], {
      cwd: root,
      env,
      signal: AbortSignal.timeout(20),
    });
    expect(timedOut).toEqual({ payload: undefined, failureCode: "TIMEOUT" });
    const offline = await runContextTreeCli(pack, ["sync", "--offline"], {
      cwd: root,
      env,
      signal: AbortSignal.timeout(2_000),
    });
    expect(abortedOnline).toBe(true);
    expect(offline).toEqual({ payload: { schemaVersion: 3, connections: [] } });
    expect(calls).toHaveLength(2);
    expect(calls[0]).not.toContain("--offline");
    expect(calls[1]).toContain("--offline");
  });

  it.each(["local", "cloud"])(
    "runs real CLI sync and publication through the %s worker, including a later execution",
    async (mode) => {
      const root = await directory();
      const pack = resolveContextTreePackage();
      if (!pack) throw new Error("Missing pinned CLI");
      const environment = {
        HOME: root,
        PATH: process.env.PATH,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.test",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.test",
      };
      const git = async (...args: string[]) => (await executeFile("git", args, { env: environment })).stdout.trim();
      const seed = join(root, "seed");
      await mkdir(seed);
      await git("init", "--initial-branch=main", seed);
      await runContextTreeCli(pack, ["init", join(seed, "docs"), "--project-path", seed, "--json"], {
        env: environment,
      });
      await git("-C", seed, "add", ".");
      await git("-C", seed, "commit", "-m", "init");
      const remote = join(root, "remote.git");
      await git("clone", "--bare", seed, remote);
      const bin = join(root, "bin");
      await mkdir(bin);
      await writeFile(
        join(bin, "git"),
        `#!/bin/sh\nexec /usr/bin/git -c protocol.file.allow=always -c 'url.file://${remote}.insteadOf=https://github.com/acme/project.git' "$@"\n`,
        { mode: 0o700 },
      );
      environment.PATH = `${bin}:${environment.PATH}`;
      const workspace = join(root, "workspace");
      await mkdir(workspace);
      await configureContextTrees(workspace, [source]);
      const owner = parent();
      const makeGateway = () =>
        new ContextTreeCommandGateway({
          parent: owner.relay,
          sources: [source],
          workspace,
          stateDirectory: join(root, "routing"),
          environment: () => environment,
          execute: async (args, privateEnvironment, signal) => {
            if (mode === "cloud") {
              const execution = executeFile(
                process.execPath,
                ["--input-type=module", "-e", CONTEXT_TREE_COMMAND_WORKER_SOURCE],
                { cwd: workspace, signal },
              );
              execution.child.stdin?.end(
                JSON.stringify({ cli: pack.cliPath, args, environment: privateEnvironment, cwd: workspace }),
              );
              return JSON.parse((await execution).stdout);
            }
            const result = await runContextTreeCli(pack, args, {
              cwd: workspace,
              network: true,
              env: { ...environment, ...privateEnvironment },
              signal,
            });
            return { code: result.failureCode ? 1 : 0, stdout: JSON.stringify(result.payload), stderr: "" };
          },
        });
      const gateway = makeGateway();
      await gateway.listen("socket");
      cleanups.push(() => gateway.close());
      const synced = await requestContextTreeCommand({ socketPath: gateway.socketPath }, ["sync"]);
      expect(synced.code).toBe(0);
      const prepared = await gateway.run(["write", "prepare"]);
      const session = JSON.parse(prepared.stdout) as { id: string; treeRoot: string };
      expect(prepared.code, prepared.stdout).toBe(0);
      await writeFile(join(session.treeRoot, "decision.md"), "---\ntitle: Decision\n---\nUse MCP for GitHub.\n");
      expect(await readFile(join(root, "routing", `${session.id}.json`), "utf8")).not.toContain("tree-local-handle");
      await gateway.close();
      const later = makeGateway();
      cleanups.push(() => later.close());
      await later.listen("socket");
      const manifest = join(root, "current.json"),
        client = join(root, "context-tree-client.mjs");
      await writeFile(client, CONTEXT_TREE_COMMAND_CLIENT_SOURCE);
      await writeFile(manifest, JSON.stringify({ environment: { OPENTAG_CONTEXT_TREE_SOCKET: later.socketPath } }));
      const providerEnvironment = {
        ...environment,
        OPENTAG_CONTEXT_TREE_MANAGED: "1",
        OPENTAG_CONTEXT_TREE_SOCKET: gateway.socketPath,
        OPENTAG_CONTEXT_TREE_MANIFEST: manifest,
      };
      const finished = await executeFile(
        process.execPath,
        [client, pack.cliPath, "write", "finish", session.id, "--message", "docs: decision", "--publish"],
        { env: providerEnvironment },
      );
      expect(JSON.parse(finished.stdout).outcome).toBe("published");
      await later.close();
      await rm(manifest);
      await expect(
        executeFile(process.execPath, [client, pack.cliPath, "sync"], { env: providerEnvironment }),
      ).rejects.toMatchObject({ stderr: expect.stringContaining("Context Tree execution unavailable") });
      expect(await git("--git-dir", remote, "show", "main:docs/decision.md")).toContain("Use MCP for GitHub.");
      await expect(readFile(join(root, "routing", `${session.id}.json`))).rejects.toMatchObject({ code: "ENOENT" });
      expect(owner.openContextTree).toHaveBeenCalledTimes(3);
      expect(owner.close).toHaveBeenCalledTimes(3);
    },
    60_000,
  );
});

describe("Context Tree gateway failure diagnostics", () => {
  const TOKEN = "ghs_AbCdEf0123456789SECRETTOKEN";
  const UNAVAILABLE = "Context Tree operation unavailable; retained work has not been discarded.\n";
  type Execute = ConstructorParameters<typeof ContextTreeCommandGateway>[0]["execute"];

  async function gatewayWith(options: {
    sources?: (typeof source)[];
    openContextTree?: () => Promise<unknown>;
    localHandleFor?: () => string;
    execute?: Execute;
    logger?: { warn: (...a: unknown[]) => void };
  }) {
    const root = await directory();
    const warn = vi.fn();
    const logger = options.logger ?? { warn };
    const controller = new AbortController();
    const child = {
      localHandleFor: options.localHandleFor ?? (() => "tree-local-handle"),
      close: vi.fn(async () => undefined),
    };
    const relay = {
      signal: controller.signal,
      openContextTree: options.openContextTree ?? (async () => child),
    } as unknown as RuntimeCredentialRelay;
    const gateway = new ContextTreeCommandGateway({
      parent: relay,
      sources: options.sources ?? [source],
      workspace: root,
      stateDirectory: join(root, "state"),
      environment: () => ({}),
      logger: { child: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn(), ...logger } as never,
      execute: options.execute ?? (async () => ({ code: 0, stdout: '{"connections":[]}', stderr: "" })),
    });
    await gateway.listen("tcp");
    cleanups.push(() => gateway.close());
    return { gateway, warn, child, root };
  }
  function post(port: number | undefined, body: string): Promise<{ status: number; body: string }> {
    return new Promise((done, reject) => {
      const request = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/command",
          method: "POST",
          headers: { "content-type": "application/json" },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => done({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
        },
      );
      request.on("error", reject);
      request.end(body);
    });
  }
  async function failing(options: Parameters<typeof gatewayWith>[0], body: unknown) {
    const { gateway, warn, root } = await gatewayWith(options);
    const response = await post(gateway.port, typeof body === "string" ? body : JSON.stringify(body));
    expect(response.status).toBe(409);
    expect(JSON.parse(response.body)).toEqual({ code: 1, stdout: "", stderr: UNAVAILABLE });
    expect(warn).toHaveBeenCalledOnce();
    const fields = warn.mock.calls[0]?.[0] as Record<string, unknown>;
    return { fields, serialized: JSON.stringify(warn.mock.calls), root };
  }

  it("logs request_parse without echoing the request body", async () => {
    const { fields, serialized } = await failing({}, `{"args": ["sync", "${TOKEN}"`);
    expect(fields).toMatchObject({ stage: "request_parse", errorName: "SyntaxError", sourcesCount: 1 });
    expect(serialized).not.toContain(TOKEN);
    expect(fields).not.toHaveProperty("argKinds");
  });

  it("logs args_validate with argument kinds but no values", async () => {
    const { fields, serialized } = await failing({}, { args: ["sync", "--bogus", TOKEN, "--tree", "acme/project"] });
    expect(fields).toMatchObject({ stage: "args_validate", argKinds: ["sync", "--bogus", "<positional>", "--tree"] });
    expect(fields.treeSelectorMatched).toBe(true);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain("acme/project");
  });

  it("logs project_path without the foreign path", async () => {
    const { fields, serialized } = await failing({}, { args: ["sync", "--project-path", "/foreign/secret-dir"] });
    expect(fields).toMatchObject({ stage: "project_path", hasProject: true, argKinds: ["sync", "--project-path"] });
    expect(serialized).not.toContain("secret-dir");
  });

  it.each([
    ["no configured sources", [] as (typeof source)[]],
    ["a selector that matches nothing", [source]],
  ])("logs tree_select for %s", async (_name, sources) => {
    const { fields, serialized } = await failing({ sources }, { args: ["sync", "--tree", "nobody/repo"] });
    expect(fields).toMatchObject({
      stage: "tree_select",
      sourcesCount: sources.length,
      treeSelectorMatched: false,
      hasProject: false,
    });
    expect(serialized).not.toContain("nobody/repo");
  });

  it("logs an unmatched session id as tree_select/session_hint without mixing in values", async () => {
    const id = "6f1c1d9e-0b6e-4a7c-9a52-1c1a3c2f9b10";
    const { fields } = await failing({}, { args: ["write", "abort", id] });
    expect(fields).toMatchObject({
      stage: "session_hint",
      sessionId: id,
      argKinds: ["write", "abort", "<positional>"],
    });
  });

  it("logs open_child with the server rejection code and redacts credential-like text", async () => {
    const { fields, serialized } = await failing(
      {
        openContextTree: async () => {
          throw new RuntimeCredentialRelayError(
            "execution_rejected",
            `rejected: tree_forbidden Bearer abc.def ${TOKEN} https://user:pw@github.com/x`,
            "tree_forbidden",
          );
        },
      },
      { args: ["sync"] },
    );
    expect(fields).toMatchObject({ stage: "open_child", code: "execution_rejected", serverCode: "tree_forbidden" });
    expect(String(fields.errorMessage)).toContain("<redacted>");
    for (const leaked of [TOKEN, "abc.def", "user:pw"]) expect(serialized).not.toContain(leaked);
  });

  it.each([
    ["acquire_failed", "acquire_provider"],
    ["ticket_failed", "ticket"],
    ["data_connect_failed", "connect_data"],
  ])("maps relay open failure %s to stage %s", async (code, stage) => {
    const { fields } = await failing(
      {
        openContextTree: async () => {
          throw new RuntimeCredentialRelayError(code as never, "rejected", "binding_revoked");
        },
      },
      { args: ["sync"] },
    );
    expect(fields).toMatchObject({ stage, serverCode: "binding_revoked" });
  });

  it("logs provider_unavailable and still closes the child", async () => {
    const { fields } = await failing(
      {
        localHandleFor: () => {
          throw new RuntimeCredentialRelayError("provider_unavailable", "Provider is not open: github");
        },
      },
      { args: ["sync"] },
    );
    expect(fields).toMatchObject({ stage: "provider_unavailable", code: "provider_unavailable" });
  });

  it("logs output_limit when the CLI result exceeds 1 MiB", async () => {
    const { fields, serialized } = await failing(
      { execute: async () => ({ code: 0, stdout: "x".repeat(1024 * 1024 + 1), stderr: "" }) },
      { args: ["sync"] },
    );
    expect(fields).toMatchObject({ stage: "output_limit", argKinds: ["sync"] });
    expect(serialized.length).toBeLessThan(2000);
  });

  it("logs execute for a failing CLI child and post_process for unparsable prepare output", async () => {
    const run = await failing(
      {
        execute: async () => {
          throw new Error("interrupted");
        },
      },
      { args: ["sync"] },
    );
    expect(run.fields).toMatchObject({ stage: "execute", errorMessage: "interrupted" });
    const parsed = await failing(
      { execute: async () => ({ code: 0, stdout: "not json", stderr: "" }) },
      { args: ["write", "prepare", "--tree", "acme/project"] },
    );
    expect(parsed.fields).toMatchObject({ stage: "post_process" });
  });

  it("keeps the 409 response when the logger itself throws", async () => {
    const { gateway } = await gatewayWith({
      logger: {
        warn: () => {
          throw new Error("log sink broken");
        },
      },
    });
    const response = await post(gateway.port, JSON.stringify({ args: ["git", "push"] }));
    expect(response.status).toBe(409);
    expect(JSON.parse(response.body)).toEqual({ code: 1, stdout: "", stderr: UNAVAILABLE });
  });

  it("does not log a successful request", async () => {
    const { gateway, warn } = await gatewayWith({});
    const response = await post(gateway.port, JSON.stringify({ args: ["sync"] }));
    expect(response.status).toBe(200);
    expect(warn).not.toHaveBeenCalled();
  });
});
