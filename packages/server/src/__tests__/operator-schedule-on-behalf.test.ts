/*
 * BeFreed fork: `onBehalfOf` provenance for operator-created Schedules. Real PostgreSQL dialect (PGlite) for the
 * agent/binding/session/message/delivery rows; the final provenance hop is then fed to the REAL
 * GitHubRuntimePolicy to show the created source is what lets GitHub / Context Tree admission through. The
 * session and schedule services are stubbed (no network, no real Slack).
 */
import { randomUUID } from "node:crypto";
import { SCHEDULE_ERROR_CODES } from "@opentag/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { OperatorCreateScheduleRequestSchema } from "../api/operator-schedules.js";
import {
  agents,
  computers,
  imBindings,
  imMessageDeliveries,
  imMessages,
  sessions,
  slackInstallations,
  users,
} from "../db/schema/index.js";
import { GitHubRuntimePolicy } from "../services/github-proxy/runtime-policy.js";
import { OperatorScheduleService } from "../services/schedules/operator-service.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

let db: UnitDatabase;
beforeAll(async () => {
  db = await createUnitDatabase();
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await db.reset();
});

const CHANNEL = "C0CHANNEL1";
const ALICE = "U0ALICE01";
const BOT = "U0BOTBOT1";

async function seed(provider: "slack" | "feishu" = "slack") {
  const accountId = randomUUID();
  const computerId = randomUUID();
  const agentId = randomUUID();
  const bindingId = randomUUID();
  const sessionId = randomUUID();
  await db.database.insert(users).values({ id: accountId, email: `${accountId}@example.test`, displayName: "Owner" });
  await db.database.insert(computers).values({
    id: computerId,
    ownerAccountId: accountId,
    kind: "local",
    currentInstallationId: randomUUID(),
    currentInstanceId: randomUUID(),
    displayName: "workstation",
    platform: "linux",
    arch: "x64",
    clientVersion: "0.0.2",
  });
  await db.database.insert(agents).values({
    id: agentId,
    createdByUserId: accountId,
    computerId,
    name: "assistant",
    displayName: "Assistant",
    runtimeProvider: "codex",
  });
  const slack = provider === "slack";
  const slackInstallationId = randomUUID();
  if (slack) {
    await db.database.insert(slackInstallations).values({
      id: slackInstallationId,
      agentId,
      status: "active",
      externalAppId: `app-${bindingId}`,
      externalTeamId: `team-${bindingId}`,
      externalBotId: BOT,
      credentialSchemaVersion: 1,
      credentialGeneration: 1,
      encryptedCredential: "encrypted",
      activatedAt: new Date(),
    });
  }
  await db.database.insert(imBindings).values({
    id: bindingId,
    agentId,
    provider,
    status: "active",
    externalAppId: `app-${bindingId}`,
    externalTeamId: `team-${bindingId}`,
    externalBotId: BOT,
    credentialSchemaVersion: 1,
    credentialGeneration: 1,
    activatedAt: new Date(),
    ...(slack ? { slackInstallationId, slackRouteKind: "default" as const } : { encryptedCredential: "encrypted" }),
  });
  await db.database.insert(sessions).values({
    id: sessionId,
    imBindingId: bindingId,
    channelId: CHANNEL,
    conversationKind: "channel",
    kind: "channel",
  });
  return { accountId, agentId, bindingId, sessionId };
}

async function say(
  s: { bindingId: string; sessionId: string },
  o: {
    author?: string;
    kind?: "human" | "bot" | "system";
    direction?: "inbound" | "outbound";
    channel?: string;
    state?: "accepted" | "pending";
    sessionId?: string;
    bindingId?: string;
    at?: Date;
  } = {},
) {
  const messageId = randomUUID();
  const deliveryId = randomUUID();
  const turnId = randomUUID();
  const accepted = (o.state ?? "accepted") === "accepted";
  await db.database.insert(imMessages).values({
    id: messageId,
    imBindingId: o.bindingId ?? s.bindingId,
    channelId: o.channel ?? CHANNEL,
    externalMessageId: `${Date.now()}.${Math.random()}`,
    providerRevisionKey: "1",
    operation: "created",
    direction: o.direction ?? "inbound",
    authorKind: o.kind ?? "human",
    authorExternalId: o.author ?? ALICE,
    content: { version: 1, fallbackText: "hi", blocks: [], truncated: false } as never,
    providerContext: { provider: "slack" } as never,
    occurredAt: o.at ?? new Date(),
  });
  await db.database.insert(imMessageDeliveries).values({
    id: deliveryId,
    messageId,
    sessionId: o.sessionId ?? s.sessionId,
    attention: "direct",
    state: o.state ?? "accepted",
    placementGeneration: 1,
    ...(accepted ? { turnId, inputHash: "h", reportOwnerInstanceId: randomUUID(), acceptedAt: new Date() } : {}),
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  return { deliveryId, turnId };
}

function harness(sessionId: string) {
  const sessionsStub = { ensureChatSession: vi.fn(async () => ({ session: { id: sessionId } }) as never) };
  const createForAgent = vi.fn(async () => ({ id: randomUUID(), revision: 1 }) as never);
  const service = new OperatorScheduleService({
    database: db.database,
    sessions: sessionsStub,
    schedules: { createForAgent, pauseForAgent: vi.fn() } as never,
    clock: { now: async () => new Date("2026-11-08T01:00:00.000Z") },
  });
  return { service, createForAgent };
}

const base = {
  channelId: CHANNEL,
  conversationKind: "channel" as const,
  name: "Daily SEO",
  prompt: "p",
  schedule: { kind: "cron" as const, expression: "0 9 * * *" },
  timezone: "UTC",
  enabled: true,
};
const onBehalf = { onBehalfOf: { slackUserId: ALICE } };
const rejected = { code: SCHEDULE_ERROR_CODES.ON_BEHALF_NOT_VERIFIED, statusCode: 409 };

describe("operator Schedule onBehalfOf (BeFreed fork)", () => {
  it("attaches the newest accepted human delivery of that user as the source, and the real policy admits it", async () => {
    const s = await seed();
    await say(s, { at: new Date("2026-11-01T00:00:00Z") });
    const newest = await say(s, { at: new Date("2026-11-05T00:00:00Z") });
    const h = harness(s.sessionId);
    await h.service.createSchedule(s.accountId, s.agentId, { ...base, ...onBehalf });
    const scope = (h.createForAgent.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(scope.userTaskSource).toEqual({
      sessionId: s.sessionId,
      source: { kind: "delivery", deliveryId: newest.deliveryId, turnId: newest.turnId },
    });

    const getOverview = vi.fn(async () => ({
      connection: { id: "gh-conn", accountId: s.accountId, authorizationVersion: "7", credentialGeneration: "3" },
    }));
    const policy = new GitHubRuntimePolicy({ database: db.database, management: { getOverview } as never });
    const src = scope.userTaskSource as { sessionId: string; source: never };
    const admitted = await policy.admit({
      accountId: s.accountId,
      agentId: s.agentId,
      sessionId: src.sessionId,
      source: src.source,
    });
    expect(admitted).toMatchObject({ connectionId: "gh-conn" });
    expect(
      await policy.authorize({
        accountId: s.accountId,
        agentId: s.agentId,
        sessionId: src.sessionId,
        source: src.source,
        provider: "github",
        purpose: "context-tree",
        bindingId: "gh-conn",
        sessionBindingId: s.bindingId,
      } as never),
    ).toBe("permit");
  });

  it("without onBehalfOf the source stays absent and the real policy denies (original behaviour)", async () => {
    const s = await seed();
    await say(s);
    const h = harness(s.sessionId);
    await h.service.createSchedule(s.accountId, s.agentId, base);
    const scope = (h.createForAgent.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(scope).toEqual({
      accountId: s.accountId,
      agentId: s.agentId,
      sessionId: s.sessionId,
      sessionKind: "channel",
    });
    const policy = new GitHubRuntimePolicy({ database: db.database, management: { getOverview: vi.fn() } as never });
    expect(await policy.admit({ accountId: s.accountId, agentId: s.agentId, sessionId: s.sessionId })).toBeUndefined();
  });

  it.each([
    ["the user never spoke (not a verified channel member)", async () => undefined],
    [
      "only somebody else spoke in the channel",
      async (s: Awaited<ReturnType<typeof seed>>) => void (await say(s, { author: "U0BOB0001" })),
    ],
    [
      "only a bot message with that id",
      async (s: Awaited<ReturnType<typeof seed>>) => void (await say(s, { kind: "bot" })),
    ],
    [
      "only an outbound message",
      async (s: Awaited<ReturnType<typeof seed>>) => void (await say(s, { direction: "outbound" })),
    ],
    [
      "only a not-yet-accepted delivery",
      async (s: Awaited<ReturnType<typeof seed>>) => void (await say(s, { state: "pending" })),
    ],
    [
      "spoke in a different channel",
      async (s: Awaited<ReturnType<typeof seed>>) => void (await say(s, { channel: "C0OTHER" })),
    ],
    [
      "spoke only in another session of the same channel",
      async (s: Awaited<ReturnType<typeof seed>>) => {
        const other = randomUUID();
        await db.database.insert(sessions).values({
          id: other,
          imBindingId: s.bindingId,
          channelId: CHANNEL,
          conversationKind: "channel",
          kind: "thread",
          threadKey: "1.1",
        });
        await say(s, { sessionId: other });
      },
    ],
  ])("rejects with 409 and never downgrades to null: %s", async (_name, arrange) => {
    const s = await seed();
    await arrange(s);
    const h = harness(s.sessionId);
    await expect(h.service.createSchedule(s.accountId, s.agentId, { ...base, ...onBehalf })).rejects.toMatchObject(
      rejected,
    );
    expect(h.createForAgent).not.toHaveBeenCalled();
  });

  it("rejects the agent's own bot user id even if a human row carries it", async () => {
    const s = await seed();
    await say(s, { author: BOT });
    const h = harness(s.sessionId);
    await expect(
      h.service.createSchedule(s.accountId, s.agentId, { ...base, onBehalfOf: { slackUserId: BOT } }),
    ).rejects.toMatchObject(rejected);
    expect(h.createForAgent).not.toHaveBeenCalled();
  });

  it("does not borrow a message from another agent's binding", async () => {
    const mine = await seed();
    const theirs = await seed();
    await say(theirs); // ALICE spoke, but under the other binding/session
    const h = harness(mine.sessionId);
    await expect(
      h.service.createSchedule(mine.accountId, mine.agentId, { ...base, ...onBehalf }),
    ).rejects.toMatchObject(rejected);
  });

  it("refuses non-Slack bindings", async () => {
    const s = await seed("feishu");
    await say(s);
    const h = harness(s.sessionId);
    await expect(h.service.createSchedule(s.accountId, s.agentId, { ...base, ...onBehalf })).rejects.toMatchObject(
      rejected,
    );
  });

  it("a caller that does not own the agent is still concealed as 404 before any lookup", async () => {
    const s = await seed();
    await say(s);
    const h = harness(s.sessionId);
    await expect(h.service.createSchedule(randomUUID(), s.agentId, { ...base, ...onBehalf })).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("the request schema accepts a Slack user id only, strictly", () => {
    const ok = OperatorCreateScheduleRequestSchema.safeParse({ ...base, ...onBehalf });
    expect(ok.success).toBe(true);
    for (const bad of [
      { slackUserId: "alice" },
      { slackUserId: ALICE, deliveryId: randomUUID() },
      { slackUserId: "" },
    ]) {
      expect(OperatorCreateScheduleRequestSchema.safeParse({ ...base, onBehalfOf: bad }).success).toBe(false);
    }
  });
});
