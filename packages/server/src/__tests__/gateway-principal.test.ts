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
  } = {},
) {
  const messageId = randomUUID();
  const deliveryId = randomUUID();
  await db.database.insert(imMessages).values({
    id: messageId,
    imBindingId: ws.bindingId,
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
    attention: "direct",
    placementGeneration: 1,
    expiresAt: new Date(Date.now() + 60_000),
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
      schedule_id: null,
      via_session: null,
      creator: null,
    });
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
    expect(principal.channel).toBeNull();
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
