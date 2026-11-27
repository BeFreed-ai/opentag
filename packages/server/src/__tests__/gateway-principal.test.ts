/*
 * BeFreed fork (patch S4): the signed principal of a gateway tool call.
 *
 * Derivation runs against the real PostgreSQL dialect (PGlite) so the joins are the ones production runs.
 * The verifier below is an independent re-implementation of the frozen contract's verifier rules; it does
 * not import anything from the signer, so a signer that drifts from the contract fails here.
 */

import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  agents,
  computers,
  imBindings,
  imMessageDeliveries,
  imMessages,
  sessionMessages,
  sessions,
  users,
} from "../db/schema/index.js";
import {
  derivePrincipal,
  type GatewayPrincipal,
  GatewayPrincipalConfigError,
  GatewayPrincipalSigner,
  parseGatewayPrincipalConfig,
} from "../runtime-credentials/gateway-principal.js";
import { sha256, verify } from "./support/gateway-principal-verifier.js";
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

/* ------------------------------------------------------------------ derivation */

async function seedWorkspace(provider: "slack" | "feishu" = "slack") {
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
  await db.database.insert(imBindings).values({
    id: bindingId,
    agentId,
    provider,
    status: "provisioning",
    externalAppId: `app-${randomUUID()}`,
    externalTeamId: provider === "slack" ? "T-TEAM-1" : null,
    externalBotId: "bot-1",
  });
  await db.database.insert(sessions).values({
    id: sessionId,
    imBindingId: bindingId,
    channelId: "C-SESSION",
    conversationKind: "channel",
    kind: "channel",
  });
  return { bindingId, sessionId };
}

async function seedDelivery(
  ws: { bindingId: string; sessionId: string },
  options: {
    authorKind?: "human" | "bot" | "system";
    author?: string;
    channel?: string;
    providerContext?: Record<string, unknown>;
    attention?: "direct" | "ambient";
    /** Make this delivery a batch member / steer of the given root, as the worker stamps it. */
    steerTarget?: string;
    bindingId?: string;
  } = {},
) {
  const messageId = randomUUID();
  const deliveryId = randomUUID();
  await db.database.insert(imMessages).values({
    id: messageId,
    imBindingId: options.bindingId ?? ws.bindingId,
    channelId: options.channel ?? "C-MESSAGE",
    externalMessageId: `m-${messageId}`,
    providerRevisionKey: "1",
    operation: "created",
    direction: "inbound",
    authorKind: options.authorKind ?? "human",
    authorExternalId: options.author ?? "U-AUTHOR",
    content: { version: 1, fallbackText: "hello", blocks: [], truncated: false },
    providerContext: (options.providerContext ?? { provider: "slack" }) as never,
    occurredAt: new Date(),
  });
  await db.database.insert(imMessageDeliveries).values({
    id: deliveryId,
    messageId,
    sessionId: ws.sessionId,
    attention: options.attention ?? "direct",
    placementGeneration: 1,
    expiresAt: new Date(Date.now() + 60_000),
    ...(options.steerTarget ? { steerTargetDeliveryId: options.steerTarget } : {}),
  });
  return { deliveryId, messageId };
}

function deliverySource(deliveryId: string) {
  return { kind: "delivery" as const, deliveryId, turnId: "turn-1" };
}

describe("derivePrincipal", () => {
  it("names the human whose message the delivery belongs to", async () => {
    const ws = await seedWorkspace();
    const { deliveryId } = await seedDelivery(ws, { author: "U-ALICE", channel: "C-ROOM" });
    const principal = await derivePrincipal(db.database, {
      sessionId: ws.sessionId,
      source: deliverySource(deliveryId),
    });
    expect(principal).toEqual<GatewayPrincipal>({
      kind: "human",
      provider: "slack",
      team: "T-TEAM-1",
      user: "U-ALICE",
      channel: "C-ROOM",
      shared_channel: null,
      attention: "direct",
      schedule_id: null,
      via_session: null,
      creator: null,
    });
  });

  it.each([
    ["true", { provider: "slack", isExtSharedChannel: true }, true],
    ["false", { provider: "slack", isExtSharedChannel: false }, false],
    ["absent", { provider: "slack" }, null],
  ])("shared_channel reflects the message's recorded flag (%s)", async (_label, providerContext, expected) => {
    const ws = await seedWorkspace();
    const { deliveryId } = await seedDelivery(ws, { providerContext });
    const principal = await derivePrincipal(db.database, {
      sessionId: ws.sessionId,
      source: deliverySource(deliveryId),
    });
    expect(principal.kind).toBe("human");
    expect(principal.shared_channel).toBe(expected);
  });

  it("shared_channel is null for Feishu, whatever the context holds", async () => {
    const ws = await seedWorkspace("feishu");
    const { deliveryId } = await seedDelivery(ws, { providerContext: { provider: "feishu", chatType: "group" } });
    const principal = await derivePrincipal(db.database, {
      sessionId: ws.sessionId,
      source: deliverySource(deliveryId),
    });
    expect(principal).toMatchObject({ kind: "human", provider: "feishu", team: null, shared_channel: null });
  });

  it("does not treat a bot-authored message as a human", async () => {
    const ws = await seedWorkspace();
    const { deliveryId } = await seedDelivery(ws, { authorKind: "bot", author: "B-OTHER" });
    const principal = await derivePrincipal(db.database, {
      sessionId: ws.sessionId,
      source: deliverySource(deliveryId),
    });
    expect(principal.kind).toBe("unknown");
    expect(principal.user).toBeNull();
    expect(principal.team).toBeNull();
  });

  it("does not treat a system-authored message as a human", async () => {
    const ws = await seedWorkspace();
    const { deliveryId } = await seedDelivery(ws, { authorKind: "system", author: "system" });
    expect(
      (await derivePrincipal(db.database, { sessionId: ws.sessionId, source: deliverySource(deliveryId) })).kind,
    ).toBe("unknown");
  });

  it("is unknown when the delivery belongs to a different session", async () => {
    const ws = await seedWorkspace();
    const { deliveryId } = await seedDelivery(ws);
    const principal = await derivePrincipal(db.database, {
      sessionId: randomUUID(),
      source: deliverySource(deliveryId),
    });
    expect(principal.kind).toBe("unknown");
  });

  it("is unknown when the delivery row is missing or its id is not even a uuid", async () => {
    const ws = await seedWorkspace();
    expect(
      (await derivePrincipal(db.database, { sessionId: ws.sessionId, source: deliverySource(randomUUID()) })).kind,
    ).toBe("unknown");
    expect(
      (await derivePrincipal(db.database, { sessionId: ws.sessionId, source: deliverySource("not-a-uuid") })).kind,
    ).toBe("unknown");
  });

  it("is unknown when the session message row is missing", async () => {
    const ws = await seedWorkspace();
    const principal = await derivePrincipal(db.database, {
      sessionId: ws.sessionId,
      source: { kind: "session-message", messageId: randomUUID() },
    });
    expect(principal.kind).toBe("unknown");
  });

  async function seedSessionMessage(
    ws: { sessionId: string },
    values: Partial<typeof sessionMessages.$inferInsert>,
  ): Promise<string> {
    const id = randomUUID();
    await db.database.insert(sessionMessages).values({
      id,
      targetSessionId: ws.sessionId,
      content: "do it",
      contentHash: createHash("sha256").update("do it").digest("hex"),
      ...values,
    });
    return id;
  }

  const origin = (scheduleId: string) => ({
    scheduleId,
    scheduledFor: "2026-11-27T01:00:00.000Z",
    timezone: "UTC",
    name: "daily",
  });

  it("scheduled with a recorded human task source: scheduled, with the creator", async () => {
    const ws = await seedWorkspace();
    const { deliveryId } = await seedDelivery(ws, { author: "U-CREATOR", channel: "C-ORIGIN" });
    const scheduleId = randomUUID();
    const messageId = await seedSessionMessage(ws, {
      scheduledOrigin: origin(scheduleId),
      userTaskSource: { sessionId: ws.sessionId, source: deliverySource(deliveryId) },
    });
    const principal = await derivePrincipal(db.database, {
      sessionId: ws.sessionId,
      source: { kind: "session-message", messageId },
    });
    expect(principal).toEqual<GatewayPrincipal>({
      kind: "scheduled",
      provider: null,
      team: null,
      user: null,
      channel: null,
      shared_channel: null,
      attention: null,
      schedule_id: scheduleId,
      via_session: null,
      creator: { provider: "slack", team: "T-TEAM-1", user: "U-CREATOR" },
    });
  });

  it("scheduled without a task source: creator is null", async () => {
    const ws = await seedWorkspace();
    const scheduleId = randomUUID();
    const messageId = await seedSessionMessage(ws, { scheduledOrigin: origin(scheduleId) });
    const principal = await derivePrincipal(db.database, {
      sessionId: ws.sessionId,
      source: { kind: "session-message", messageId },
    });
    expect(principal.kind).toBe("scheduled");
    expect(principal.schedule_id).toBe(scheduleId);
    expect(principal.creator).toBeNull();
  });

  it("scheduled whose task source points at a bot message or a missing delivery: creator is null, still scheduled", async () => {
    const ws = await seedWorkspace();
    const bot = await seedDelivery(ws, { authorKind: "bot", author: "B-1" });
    for (const deliveryId of [bot.deliveryId, randomUUID()]) {
      const messageId = await seedSessionMessage(ws, {
        scheduledOrigin: origin(randomUUID()),
        userTaskSource: { sessionId: ws.sessionId, source: deliverySource(deliveryId) },
      });
      const principal = await derivePrincipal(db.database, {
        sessionId: ws.sessionId,
        source: { kind: "session-message", messageId },
      });
      expect(principal.kind).toBe("scheduled");
      expect(principal.creator).toBeNull();
    }
  });

  it("an agent-to-agent session message: agent, via the source session, no user", async () => {
    const ws = await seedWorkspace();
    const sourceSessionId = randomUUID();
    await db.database.insert(sessions).values({
      id: sourceSessionId,
      imBindingId: ws.bindingId,
      channelId: "C-OTHER",
      conversationKind: "channel",
      kind: "thread",
      threadKey: "t1",
    });
    const messageId = await seedSessionMessage(ws, { sourceSessionId });
    const principal = await derivePrincipal(db.database, {
      sessionId: ws.sessionId,
      source: { kind: "session-message", messageId },
    });
    expect(principal).toEqual<GatewayPrincipal>({
      kind: "agent",
      provider: null,
      team: null,
      user: null,
      channel: null,
      shared_channel: null,
      attention: null,
      schedule_id: null,
      via_session: sourceSessionId,
      creator: null,
    });
  });

  it("a validation execution is the system", async () => {
    const ws = await seedWorkspace();
    const principal = await derivePrincipal(db.database, {
      sessionId: ws.sessionId,
      source: { kind: "validation", validationRunId: randomUUID() },
    });
    expect(principal.kind).toBe("system");
    expect(principal.user).toBeNull();
  });

  it("an unexpected source is unknown, and a failing database never throws", async () => {
    const ws = await seedWorkspace();
    expect(
      (await derivePrincipal(db.database, { sessionId: ws.sessionId, source: { kind: "mystery" } as never })).kind,
    ).toBe("unknown");
    const broken = {
      select: () => {
        throw new Error("database is down");
      },
    } as never;
    expect(
      (await derivePrincipal(broken, { sessionId: ws.sessionId, source: deliverySource(randomUUID()) })).kind,
    ).toBe("unknown");
  });
});

/* ------------------------------------------------------------------ turn rule */

/** A second IM binding (of another agent) in the same workspace, for "same author id, different binding". */
async function seedOtherBinding(): Promise<string> {
  const [agent] = await db.database.select().from(agents).limit(1);
  const otherAgentId = randomUUID();
  const bindingId = randomUUID();
  await db.database.insert(agents).values({
    id: otherAgentId,
    createdByUserId: (agent as { createdByUserId: string }).createdByUserId,
    computerId: (agent as { computerId: string }).computerId,
    name: "other",
    displayName: "Other",
    runtimeProvider: "codex",
  });
  await db.database.insert(imBindings).values({
    id: bindingId,
    agentId: otherAgentId,
    provider: "slack",
    status: "provisioning",
    externalAppId: `app-${randomUUID()}`,
    externalTeamId: "T-TEAM-1",
    externalBotId: "bot-2",
  });
  return bindingId;
}

describe("derivePrincipal over the whole turn", () => {
  const principalOf = (ws: { sessionId: string }, rootId: string) =>
    derivePrincipal(db.database, { sessionId: ws.sessionId, source: deliverySource(rootId) });

  it("a batch member by another author makes the turn unknown", async () => {
    const ws = await seedWorkspace();
    const root = await seedDelivery(ws, { author: "U-A" });
    await seedDelivery(ws, { author: "U-B", steerTarget: root.deliveryId });
    const principal = await principalOf(ws, root.deliveryId);
    expect(principal.kind).toBe("unknown");
    expect(principal.user).toBeNull();
    expect(principal.team).toBeNull();
  });

  it("a steer by another author makes the turn unknown; a steer by the same author keeps it human", async () => {
    const ws = await seedWorkspace();
    const root = await seedDelivery(ws, { author: "U-A" });
    await seedDelivery(ws, { author: "U-A", steerTarget: root.deliveryId });
    expect(await principalOf(ws, root.deliveryId)).toMatchObject({ kind: "human", user: "U-A" });
    await seedDelivery(ws, { author: "U-B", steerTarget: root.deliveryId });
    expect((await principalOf(ws, root.deliveryId)).kind).toBe("unknown");
  });

  it("a steer arriving between two tool calls flips the second call to unknown", async () => {
    const ws = await seedWorkspace();
    const root = await seedDelivery(ws, { author: "U-A" });
    const first = await principalOf(ws, root.deliveryId);
    await seedDelivery(ws, { author: "U-B", steerTarget: root.deliveryId });
    const second = await principalOf(ws, root.deliveryId);
    expect([first.kind, second.kind]).toEqual(["human", "unknown"]);
  });

  it("a member that is a bot or system makes the turn unknown", async () => {
    for (const authorKind of ["bot", "system"] as const) {
      const ws = await seedWorkspace();
      const root = await seedDelivery(ws, { author: "U-A" });
      await seedDelivery(ws, { authorKind, author: "U-A", steerTarget: root.deliveryId });
      expect((await principalOf(ws, root.deliveryId)).kind).toBe("unknown");
    }
  });

  it("the same author id on a different binding is not the same author", async () => {
    const ws = await seedWorkspace();
    const root = await seedDelivery(ws, { author: "U-A" });
    const otherBinding = await seedOtherBinding();
    await seedDelivery(ws, { author: "U-A", steerTarget: root.deliveryId, bindingId: otherBinding });
    expect((await principalOf(ws, root.deliveryId)).kind).toBe("unknown");
  });

  it("follows a member still pointing at a steer delivery that points at the root", async () => {
    const ws = await seedWorkspace();
    const root = await seedDelivery(ws, { author: "U-A" });
    const steer = await seedDelivery(ws, { author: "U-A", steerTarget: root.deliveryId });
    await seedDelivery(ws, { author: "U-B", steerTarget: steer.deliveryId });
    expect((await principalOf(ws, root.deliveryId)).kind).toBe("unknown");
  });

  it("ignores deliveries of other turns and other sessions", async () => {
    const ws = await seedWorkspace();
    const root = await seedDelivery(ws, { author: "U-A" });
    await seedDelivery(ws, { author: "U-B" });
    const other = await seedWorkspace();
    await seedDelivery(other, { author: "U-B", steerTarget: root.deliveryId });
    expect(await principalOf(ws, root.deliveryId)).toMatchObject({ kind: "human", user: "U-A" });
  });

  it("shared_channel: true on a member only is true; a member without the flag is null; all false is false", async () => {
    const ws = await seedWorkspace();
    const root = await seedDelivery(ws, {
      author: "U-A",
      providerContext: { provider: "slack", isExtSharedChannel: false },
    });
    expect((await principalOf(ws, root.deliveryId)).shared_channel).toBe(false);
    await seedDelivery(ws, { author: "U-A", steerTarget: root.deliveryId, providerContext: { provider: "slack" } });
    expect((await principalOf(ws, root.deliveryId)).shared_channel).toBeNull();
    await seedDelivery(ws, {
      author: "U-A",
      steerTarget: root.deliveryId,
      providerContext: { provider: "slack", isExtSharedChannel: true },
    });
    expect((await principalOf(ws, root.deliveryId)).shared_channel).toBe(true);
  });

  it("attention: any ambient delivery makes the turn ambient; all direct is direct", async () => {
    const ws = await seedWorkspace();
    const root = await seedDelivery(ws, { author: "U-A" });
    expect((await principalOf(ws, root.deliveryId)).attention).toBe("direct");
    await seedDelivery(ws, { author: "U-A", steerTarget: root.deliveryId, attention: "ambient" });
    const principal = await principalOf(ws, root.deliveryId);
    expect(principal).toMatchObject({ kind: "human", attention: "ambient" });
  });

  it("an ambient root alone is ambient", async () => {
    const ws = await seedWorkspace();
    const root = await seedDelivery(ws, { author: "U-A", attention: "ambient" });
    expect((await principalOf(ws, root.deliveryId)).attention).toBe("ambient");
  });
});

describe("derivePrincipal: session pin on session messages", () => {
  it("a scheduled message that targets a different session than the execution's is unknown", async () => {
    const ws = await seedWorkspace();
    const otherSessionId = randomUUID();
    await db.database.insert(sessions).values({
      id: otherSessionId,
      imBindingId: ws.bindingId,
      channelId: "C-ELSEWHERE",
      conversationKind: "channel",
      kind: "thread",
      threadKey: "t-other",
    });
    const id = randomUUID();
    await db.database.insert(sessionMessages).values({
      id,
      targetSessionId: otherSessionId,
      content: "do it",
      contentHash: createHash("sha256").update("do it").digest("hex"),
      scheduledOrigin: {
        scheduleId: randomUUID(),
        scheduledFor: "2026-11-27T01:00:00.000Z",
        timezone: "UTC",
        name: "daily",
      },
    });
    const principal = await derivePrincipal(db.database, {
      sessionId: ws.sessionId,
      source: { kind: "session-message", messageId: id },
    });
    expect(principal.kind).toBe("unknown");
    expect(principal.schedule_id).toBeNull();
  });
});

/* ------------------------------------------------------------------ signing */

const SECRET_A = "a".repeat(40);
const SECRET_B = "b".repeat(40);
const NOW_MS = Date.UTC(2026, 10, 27, 1, 0, 0);

const PRINCIPAL: GatewayPrincipal = {
  kind: "human",
  provider: "slack",
  team: "T-TEAM-1",
  user: "U-ALICE",
  channel: "C-ROOM",
  shared_channel: false,
  attention: null,
  schedule_id: null,
  via_session: null,
  creator: null,
};

function context(principal: GatewayPrincipal = PRINCIPAL) {
  return { account: "acct-1", agent: "agent-1", execution: "exec-1", tool: "send", principal };
}

describe("GatewayPrincipalSigner", () => {
  const keys = { "ot-a": SECRET_A, "ot-b": SECRET_B };
  const signer = () => new GatewayPrincipalSigner(new Map(Object.entries(keys)), "ot-a", () => NOW_MS);
  const body = JSON.stringify({ jsonrpc: "2.0", id: "1", method: "tools/call", params: { name: "send" } });

  it("is accepted by an independent verifier and carries exactly the contract's keys", () => {
    const { headers } = signer().sign(context(), sha256(body));
    const verdict = verify(headers, body, { keys, nowMs: NOW_MS });
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(Object.keys(verdict.statement)).toEqual([
      "v",
      "gateway",
      "account",
      "agent",
      "execution",
      "call",
      "tool",
      "iat",
      "principal",
    ]);
    expect(verdict.statement).toMatchObject({
      v: 1,
      gateway: "opentag",
      account: "acct-1",
      agent: "agent-1",
      execution: "exec-1",
      tool: "send",
      principal: PRINCIPAL,
    });
    expect(String(verdict.statement.call)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(headers["X-Opentag-Principal-Signature"]).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(headers["X-Opentag-Principal-Key"]).toBe("ot-a");
  });

  it("iat equals the timestamp header", () => {
    const { headers } = signer().sign(context(), sha256(body));
    const statement = JSON.parse(Buffer.from(headers["X-Opentag-Principal"] as string, "base64url").toString("utf8"));
    expect(headers["X-Opentag-Principal-Timestamp"]).toBe(String(NOW_MS / 1000));
    expect(statement.iat).toBe(Number(headers["X-Opentag-Principal-Timestamp"]));
  });

  it("uses a new call id for every request", () => {
    const s = signer();
    const first = s.sign(context(), sha256(body));
    const second = s.sign(context(), sha256(body));
    expect(first.call).not.toBe(second.call);
    const seen = new Set<string>();
    expect(verify(first.headers, body, { keys, nowMs: NOW_MS, seen }).ok).toBe(true);
    expect(verify(second.headers, body, { keys, nowMs: NOW_MS, seen }).ok).toBe(true);
    expect(verify(first.headers, body, { keys, nowMs: NOW_MS, seen })).toEqual({ ok: false, reason: "replay" });
  });

  it("rejects one changed byte of the body", () => {
    const { headers } = signer().sign(context(), sha256(body));
    expect(verify(headers, `${body} `, { keys, nowMs: NOW_MS })).toEqual({ ok: false, reason: "bad signature" });
    expect(verify(headers, body.replace("send", "sene"), { keys, nowMs: NOW_MS })).toEqual({
      ok: false,
      reason: "bad signature",
    });
  });

  it("rejects a changed timestamp, key id or principal", () => {
    const { headers } = signer().sign(context(), sha256(body));
    expect(
      verify({ ...headers, "X-Opentag-Principal-Timestamp": String(NOW_MS / 1000 + 1) }, body, { keys, nowMs: NOW_MS }),
    ).toEqual({ ok: false, reason: "bad signature" });
    expect(verify({ ...headers, "X-Opentag-Principal-Key": "ot-b" }, body, { keys, nowMs: NOW_MS })).toEqual({
      ok: false,
      reason: "bad signature",
    });
    const other = signer().sign(context({ ...PRINCIPAL, user: "U-MALLORY" }), sha256(body));
    expect(
      verify({ ...headers, "X-Opentag-Principal": other.headers["X-Opentag-Principal"] as string }, body, {
        keys,
        nowMs: NOW_MS,
      }),
    ).toEqual({ ok: false, reason: "bad signature" });
  });

  it("is rejected when the verifier does not hold the key or the clock is far away", () => {
    const { headers } = signer().sign(context(), sha256(body));
    expect(verify(headers, body, { keys: { "ot-b": SECRET_B }, nowMs: NOW_MS })).toEqual({
      ok: false,
      reason: "unknown key",
    });
    expect(verify(headers, body, { keys, nowMs: NOW_MS + 61_000 })).toEqual({ ok: false, reason: "stale" });
  });

  it("signs with the active key, so a rotation is just a new active id", () => {
    const rotated = new GatewayPrincipalSigner(new Map(Object.entries(keys)), "ot-b", () => NOW_MS);
    const { headers } = rotated.sign(context(), sha256(body));
    expect(headers["X-Opentag-Principal-Key"]).toBe("ot-b");
    expect(verify(headers, body, { keys, nowMs: NOW_MS }).ok).toBe(true);
  });
});

/* ------------------------------------------------------------------ config */

describe("parseGatewayPrincipalConfig", () => {
  const KEYS = "OPENTAG_GATEWAY_PRINCIPAL_KEYS";
  const ID = "OPENTAG_GATEWAY_PRINCIPAL_KEY_ID";

  it("returns no signer when neither variable is set", () => {
    expect(parseGatewayPrincipalConfig({})).toBeUndefined();
    expect(parseGatewayPrincipalConfig({ [KEYS]: "  ", [ID]: "" })).toBeUndefined();
  });

  it("builds a signer from a valid map and id", () => {
    const signer = parseGatewayPrincipalConfig({ [KEYS]: JSON.stringify({ "ot-1": SECRET_A }), [ID]: "ot-1" });
    expect(signer).toBeInstanceOf(GatewayPrincipalSigner);
  });

  it.each([
    ["malformed JSON", { [KEYS]: "{not json", [ID]: "ot-1" }],
    ["a JSON array", { [KEYS]: JSON.stringify([SECRET_A]), [ID]: "ot-1" }],
    ["an empty map", { [KEYS]: "{}", [ID]: "ot-1" }],
    ["an unknown key id", { [KEYS]: JSON.stringify({ "ot-1": SECRET_A }), [ID]: "ot-9" }],
    ["a secret shorter than 32 bytes", { [KEYS]: JSON.stringify({ "ot-1": "short-secret" }), [ID]: "ot-1" }],
    ["a non-string secret", { [KEYS]: JSON.stringify({ "ot-1": 12345 }), [ID]: "ot-1" }],
    ["a key id with a dot", { [KEYS]: JSON.stringify({ "ot.1": SECRET_A }), [ID]: "ot.1" }],
    ["keys without an id", { [KEYS]: JSON.stringify({ "ot-1": SECRET_A }) }],
    ["an id without keys", { [ID]: "ot-1" }],
  ])("is a startup config error for %s", (_label, environment) => {
    expect(() => parseGatewayPrincipalConfig(environment)).toThrow(GatewayPrincipalConfigError);
  });

  it("never puts a secret in an error message", () => {
    const secret = "very-secret-value-0123456789-0123456789";
    for (const environment of [
      { [KEYS]: JSON.stringify({ "ot-1": secret }), [ID]: "ot-9" },
      { [KEYS]: `{"ot-1": "${secret}"`, [ID]: "ot-1" },
      { [KEYS]: JSON.stringify({ "ot.1": secret }), [ID]: "ot.1" },
    ]) {
      try {
        parseGatewayPrincipalConfig(environment);
        throw new Error("expected a config error");
      } catch (error) {
        expect((error as Error).message).not.toContain(secret);
      }
    }
  });
});
