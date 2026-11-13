import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AgentGitHubCredentialService } from "../services/github/agent-github-credential-service.js";
import { matchesGitHubMcpFence } from "../services/mcp/github-authorization.js";
import { githubMcpFixture } from "./support/github-mcp.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

const NAME = "befreed-memory-github";
const GITHUB_MCP = "https://api.githubcopilot.com/mcp/";

let unit: UnitDatabase;
beforeAll(async () => {
  unit = await createUnitDatabase();
}, 60_000);
afterAll(async () => unit?.close());
beforeEach(async () => unit.reset());

async function setup(options: { name?: string; url?: string; serverName?: string; enabled?: boolean } = {}) {
  const f = await githubMcpFixture(unit.database);
  const bearerServer = await f.servers.createServer(f.accountId, {
    name: options.name ?? NAME,
    url: options.url ?? GITHUB_MCP,
    defaultAuthKind: "bearer",
  });
  // By default the Agent's only GitHub mount is the Bearer connector; `keepShared` leaves the older OAuth mount.
  const mount = async (agentId: string, key: string, keepShared = false) => {
    if (!keepShared) await f.servers.detachServer(f.accountId, agentId, f.server.id);
    await f.servers.attachServer(f.accountId, agentId, bearerServer.id, true);
    await f.auth.setBearerOrNone(f.accountId, agentId, bearerServer.id, { kind: "bearer", bearerKey: key });
  };
  const service = (enabled: boolean, serverName = options.serverName ?? NAME) =>
    new AgentGitHubCredentialService({
      database: unit.database,
      authorization: f.auth,
      api: f.api,
      configured: true,
      externalBearer: { enabled, serverName },
      // A Bearer key has no OAuth client, so this real check would refuse it: the Bearer path must bypass it.
      trustedClient: (...args) => f.flows.reusableClient(...args),
    });
  const credential = async (github: AgentGitHubCredentialService, agentId: string, version: string | undefined) =>
    github.getExecutionUserCredential({
      accountId: f.accountId,
      agentId,
      connectionId: bearerServer.id,
      authorizationRevision: `github:${version}`,
    });
  return { f, bearerServer, mount, service, credential };
}

describe("external Bearer GitHub connector (off by default)", () => {
  it("accepts the named Bearer connector when enabled and hands back the rotated key", async () => {
    const { f, bearerServer, mount, service, credential } = await setup();
    const agentId = f.ids[2] as string;
    await mount(agentId, "ghs_first");
    const github = service(true);
    const { connection } = await github.getOverview(f.accountId, agentId);
    expect(connection?.id).toBe(bearerServer.id);
    expect(connection?.fence?.localAuthorizationId).toBe(connection?.fence?.rootAuthorizationId);
    expect((await credential(github, agentId, connection?.authorizationVersion))?.accessToken).toBe("ghs_first");
  });

  it("keeps rejecting a Bearer connector while the switch is off, and when it is not passed at all", async () => {
    const { f, mount, service } = await setup();
    const agentId = f.ids[2] as string;
    await mount(agentId, "ghs_first");
    await expect(service(false).getOverview(f.accountId, agentId)).rejects.toMatchObject({
      code: "github_connector_unsupported",
    });
    const bare = new AgentGitHubCredentialService({
      database: unit.database,
      authorization: f.auth,
      api: f.api,
      configured: true,
      trustedClient: () => true,
    });
    await expect(bare.getOverview(f.accountId, agentId)).rejects.toMatchObject({
      code: "github_connector_unsupported",
    });
  });

  it.each([
    ["the name is not the configured one", { name: "some-other-github" }],
    ["the name differs only by case", { name: "Befreed-Memory-GitHub" }],
  ])("rejects a Bearer connector when %s", async (_label, options) => {
    const { f, mount, service } = await setup(options);
    const agentId = f.ids[2] as string;
    await mount(agentId, "ghs_first");
    await expect(service(true).getOverview(f.accountId, agentId)).rejects.toMatchObject({
      code: "github_connector_unsupported",
    });
  });

  it("rejects the configured name on a URL that is not exactly the GitHub MCP endpoint", async () => {
    // Same GitHub endpoint without the trailing slash: found as a GitHub mount, refused as Bearer.
    const slashless = await setup({ url: "https://api.githubcopilot.com/mcp" });
    await slashless.mount(slashless.f.ids[2] as string, "ghs_first");
    await expect(
      slashless.service(true).getOverview(slashless.f.accountId, slashless.f.ids[2] as string),
    ).rejects.toMatchObject({ code: "github_connector_unsupported" });
    // A different host never reaches the GitHub path at all.
    const foreign = await setup({ url: "https://attacker.example.test/mcp" });
    await foreign.mount(foreign.f.ids[2] as string, "ghs_first");
    expect(
      (await foreign.service(true).getOverview(foreign.f.accountId, foreign.f.ids[2] as string)).connection,
    ).toBeNull();
  });

  it("mirror: another connector name and another Agent behave the same way", async () => {
    const { f, bearerServer, mount, service, credential } = await setup({ name: "acme-memory-github" });
    const agentId = f.ids[3] as string;
    await mount(agentId, "ghs_mirror");
    await expect(service(true).getOverview(f.accountId, agentId)).rejects.toMatchObject({
      code: "github_connector_unsupported",
    });
    const github = service(true, "acme-memory-github");
    const { connection } = await github.getOverview(f.accountId, agentId);
    expect(connection?.id).toBe(bearerServer.id);
    expect((await credential(github, agentId, connection?.authorizationVersion))?.accessToken).toBe("ghs_mirror");
  });

  it("leaves the OAuth path exactly as it was, with the switch on or off", async () => {
    const { f, service } = await setup();
    const agentId = f.ids[0] as string;
    for (const enabled of [true, false]) {
      const { connection } = await service(enabled).getOverview(f.accountId, agentId);
      expect(connection?.fence?.rootAuthorizationId).toBe(f.root.id);
      expect(connection?.fence?.externalBearerServerName).toBeUndefined();
      const credential = await service(enabled).getExecutionUserCredential({
        accountId: f.accountId,
        agentId,
        connectionId: f.server.id,
        authorizationRevision: `github:${connection?.authorizationVersion}`,
      });
      expect(credential?.accessToken).toBe("old-access");
    }
  });

  it("prefers the Bearer connector over an older OAuth mount only while the switch is on", async () => {
    const { f, bearerServer, mount, service } = await setup();
    const agentId = f.ids[0] as string; // already holds the older shared OAuth mount
    await mount(agentId, "ghs_first", true);
    expect((await service(true).getOverview(f.accountId, agentId)).connection?.id).toBe(bearerServer.id);
    expect((await service(false).getOverview(f.accountId, agentId)).connection?.id).toBe(f.server.id);
  });

  it("keeps the authorization version and an in-flight fence valid across key rotation", async () => {
    const { f, bearerServer, mount, service, credential } = await setup();
    const agentId = f.ids[2] as string;
    await mount(agentId, "ghs_first");
    const github = service(true);
    const before = (await github.getOverview(f.accountId, agentId)).connection;
    const revisionBefore = (await f.row(agentId))?.revision;
    for (const key of ["ghs_second", "ghs_third"])
      await f.auth.setBearerOrNone(f.accountId, agentId, bearerServer.id, { kind: "bearer", bearerKey: key });
    expect((await f.row(agentId))?.revision).toBe((revisionBefore ?? 0) + 2);
    const after = (await github.getOverview(f.accountId, agentId)).connection;
    expect(after?.authorizationVersion).toBe(before?.authorizationVersion);
    expect(after?.fence?.localAuthorizationId).toBe(before?.fence?.localAuthorizationId);
    expect((await credential(github, agentId, before?.authorizationVersion))?.accessToken).toBe("ghs_third");
    const fence = before?.fence;
    if (!fence) throw new Error("Missing fence");
    expect(await unit.database.transaction((tx) => matchesGitHubMcpFence(tx, fence))).toBe(true);
  });

  it("invalidates the fence when the connector's endpoint configuration changes", async () => {
    const { f, bearerServer, mount, service } = await setup();
    const agentId = f.ids[2] as string;
    await mount(agentId, "ghs_first");
    const before = (await service(true).getOverview(f.accountId, agentId)).connection;
    await f.servers.updateServer(f.accountId, bearerServer.id, {
      expectedRevision: bearerServer.revision,
      extraHeaders: { "x-mcp-readonly": "true" },
    });
    const after = (await service(true).getOverview(f.accountId, agentId)).connection;
    expect(after?.authorizationVersion).not.toBe(before?.authorizationVersion);
    expect(after?.readOnly).toBe(true);
  });
});
