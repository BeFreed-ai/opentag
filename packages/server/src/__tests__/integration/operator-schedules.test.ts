/*
 * BeFreed fork: operator-only Schedule creation against real PostgreSQL, through the real app, the real
 * OperatorScheduleService / ScheduleService / SessionService, and the real ScheduleScheduler (only the final
 * hand-off to a Computer is a fake). It proves what the stubbed route test cannot: ownership concealment, no
 * orphan schedule on a refused request, the created schedule is visible through the EXISTING account
 * list/get routes, and the existing scheduler claims and dispatches it with no inbound IM message.
 */

import { randomUUID } from "node:crypto";
import { agentSchedulePath, agentSchedulesPath } from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../app.js";
import { createDatabaseClient } from "../../db/client.js";
import { agentSchedules, agents, computers, imBindings, sessions, users } from "../../db/schema/index.js";
import { DatabaseAgentOwnerResolver } from "../../services/agents/index.js";
import type { UserAuthService } from "../../services/auth/index.js";
import { ScheduleScheduler, ScheduleService } from "../../services/schedules/index.js";
import { OperatorScheduleService } from "../../services/schedules/operator-service.js";
import { SessionService } from "../../services/sessions/index.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

const PUBLIC_URL = "https://opentag.example.com";
let testDatabase: MigratedTestDatabase;
let client: ReturnType<typeof createDatabaseClient>;
let app: ReturnType<typeof createApp>;
let scheduler: ScheduleScheduler;
const dispatch = { dispatchScheduledMessage: vi.fn(async () => ({ outcome: "accepted" as const, code: null })) };
const logger = { info: vi.fn(), warn: vi.fn() };
const schedulerLogger = { info: vi.fn(), error: vi.fn() };

beforeAll(async () => {
  testDatabase = await startMigratedTestDatabase();
}, 120_000);
afterAll(async () => {
  await testDatabase.stop();
});

interface Seed {
  userId: string;
  token: string;
  agentId: string;
  bindingId: string | null;
  computerId: string | null;
}

async function seedAccount(options: { binding?: boolean; computer?: boolean } = {}): Promise<Seed> {
  const db = client.database;
  const userId = randomUUID();
  await db.insert(users).values({ id: userId, email: `${userId}@example.test`, displayName: "Owner" });
  let computerId: string | null = null;
  if (options.computer !== false) {
    computerId = randomUUID();
    await db.insert(computers).values({
      id: computerId,
      ownerAccountId: userId,
      kind: "local",
      currentInstallationId: randomUUID(),
      currentInstanceId: randomUUID(),
      displayName: "workstation",
      platform: "linux",
      arch: "x64",
      clientVersion: "0.0.2",
    });
  }
  const agentId = randomUUID();
  await db.insert(agents).values({
    id: agentId,
    createdByUserId: userId,
    ...(computerId ? { computerId } : {}),
    name: `agent-${agentId.slice(0, 8)}`,
    displayName: "Assistant",
    runtimeProvider: "codex",
  });
  let bindingId: string | null = null;
  if (options.binding !== false) {
    bindingId = randomUUID();
    await db.insert(imBindings).values({
      id: bindingId,
      agentId,
      provider: "feishu",
      status: "active",
      externalAppId: `app-${randomUUID()}`,
      externalBotId: "ou_bot",
      credentialSchemaVersion: 1,
      credentialGeneration: 1,
      encryptedCredential: "test-only",
      activatedAt: new Date(),
    });
  }
  return { userId, token: `token-${userId}`, agentId, bindingId, computerId };
}

let tokens: Map<string, string>;
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

beforeEach(async () => {
  await testDatabase.reset();
  dispatch.dispatchScheduledMessage.mockClear();
  logger.info.mockClear();
  logger.warn.mockClear();
  schedulerLogger.info.mockClear();
  client = createDatabaseClient(testDatabase.databaseUrl);
  tokens = new Map();
});

afterEach(async () => {
  await app?.close();
  await client.sql.end();
});

/** `lagMs` shifts the creation clock into the past so a run-now schedule is already due when scanned. */
function startApp(allowedUserIds: string[], lagMs = 0) {
  const sessionService = new SessionService(client.database);
  const clock = { now: async () => new Date(Date.now() - lagMs) };
  const scheduleService = new ScheduleService({
    database: client.database,
    owners: new DatabaseAgentOwnerResolver(client.database),
    proofs: { authenticate: () => Promise.reject(new Error("no proofs in this suite")) },
    publicUrl: PUBLIC_URL,
    clock,
  });
  const authService = {
    getAuthenticatedUser: vi.fn(async (token: string) => {
      const userId = tokens.get(token);
      if (!userId) throw Object.assign(new Error("invalid"), { statusCode: 401 });
      return {
        tokenExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
        me: { user: { id: userId, email: `${userId}@example.test`, displayName: "Owner" }, setupCompletedAt: null },
      };
    }),
  } as unknown as UserAuthService;
  app = createApp({
    authService,
    agentSchedules: { service: scheduleService },
    operatorSchedules: {
      service: new OperatorScheduleService({
        database: client.database,
        sessions: sessionService,
        schedules: scheduleService,
        clock,
      }),
      allowedUserIds: new Set(allowedUserIds),
      logger,
    },
  });
  scheduler = new ScheduleScheduler({
    database: client.database,
    dispatch: dispatch as never,
    sessions: sessionService,
    publicUrl: PUBLIC_URL,
    logger: schedulerLogger,
  });
}

const cronBody = {
  channelId: "D0123",
  conversationKind: "dm",
  name: "Daily SEO",
  prompt: "Run the daily SEO stage 1.",
  schedule: { kind: "cron", expression: "0 9 * * *" },
  timezone: "America/Los_Angeles",
};
const post = (agentId: string, token: string, payload: unknown) =>
  app.inject({
    method: "POST",
    url: `/api/v1/operator/agents/${agentId}/schedules`,
    headers: bearer(token),
    payload: payload as never,
  });

async function counts() {
  const [s, sch] = await Promise.all([
    client.database.select().from(sessions),
    client.database.select().from(agentSchedules),
  ]);
  return { sessions: s.length, schedules: sch.length };
}

describe("operator schedule creation (real PostgreSQL)", () => {
  it("creates a cron schedule with no prior session; the existing list/get routes return it", async () => {
    const op = await seedAccount();
    tokens.set(op.token, op.userId);
    startApp([op.userId]);
    expect(await counts()).toEqual({ sessions: 0, schedules: 0 });

    const response = await post(op.agentId, op.token, cronBody);
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body).toMatchObject({
      agentId: op.agentId,
      name: "Daily SEO",
      prompt: "Run the daily SEO stage 1.",
      schedule: { kind: "cron", expression: "0 9 * * *" },
      timezone: "America/Los_Angeles",
      enabled: true,
      revision: 1,
      target: { provider: "feishu", sessionKind: "channel", channelId: "D0123", threadKey: null },
    });
    expect(await counts()).toEqual({ sessions: 1, schedules: 1 });

    const list = await app.inject({ method: "GET", url: agentSchedulesPath(op.agentId), headers: bearer(op.token) });
    expect(list.statusCode).toBe(200);
    expect(list.json().items.map((item: { id: string }) => item.id)).toEqual([body.id]);
    const get = await app.inject({
      method: "GET",
      url: agentSchedulePath(op.agentId, body.id),
      headers: bearer(op.token),
    });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toMatchObject({ id: body.id, prompt: "Run the daily SEO stage 1." });

    // Same channel again reuses the one session (idempotent), and a one-time `at` rule works too.
    const second = await post(op.agentId, op.token, {
      ...cronBody,
      name: "Once",
      schedule: { kind: "at", at: new Date(Date.now() + 3_600_000).toISOString() },
      timezone: "UTC",
    });
    expect(second.statusCode).toBe(201);
    expect(second.json().schedule.kind).toBe("at");
    expect(await counts()).toEqual({ sessions: 1, schedules: 2 });
  });

  it("run-now: due schedule is claimed and dispatched by the existing scheduler; an `enabled:false` one is not", async () => {
    const op = await seedAccount();
    tokens.set(op.token, op.userId);
    // Fake clock: creation time is 20 s in the past, so now+5 s is already due and inside the 30 s claim window.
    startApp([op.userId], 20_000);
    const { schedule: _s, timezone: _t, ...base } = cronBody;
    const runNow = await post(op.agentId, op.token, { ...base, name: "Run now", runInSeconds: 5 });
    expect(runNow.statusCode).toBe(201);
    expect(runNow.json().schedule.kind).toBe("at");
    const paused = await post(op.agentId, op.token, { ...cronBody, name: "Paused", enabled: false });
    expect(paused.statusCode).toBe(201);
    expect(paused.json()).toMatchObject({ enabled: false, nextTriggerAt: null, revision: 2 });

    await scheduler.scanNow();
    expect(dispatch.dispatchScheduledMessage).toHaveBeenCalledTimes(1);
    const call = dispatch.dispatchScheduledMessage.mock.calls[0] as unknown as [
      { scheduleId: string; content: string },
    ];
    expect(call[0]).toMatchObject({ scheduleId: runNow.json().id, content: "Run the daily SEO stage 1." });
    const read = async () =>
      (
        await app.inject({
          method: "GET",
          url: agentSchedulePath(op.agentId, runNow.json().id),
          headers: bearer(op.token),
        })
      ).json();
    // The scheduler logs the settled hand-off just after it returns.
    await vi.waitFor(
      () =>
        expect(schedulerLogger.info).toHaveBeenCalledWith(
          expect.objectContaining({ event: "schedule.dispatched", scheduleId: runNow.json().id, outcome: "accepted" }),
          expect.any(String),
        ),
      { timeout: 5_000 },
    );
    // The claim recorded the occurrence (the fake hand-off does not write the final outcome).
    expect((await read()).lastDispatch).toMatchObject({
      messageId: expect.any(String),
      attemptedAt: expect.any(String),
    });
    await scheduler.stop();
    expect((await read()).enabled).toBe(true);
    // The disabled schedule was never claimed.
    const pausedRow = await client.database
      .select()
      .from(agentSchedules)
      .where(eq(agentSchedules.id, paused.json().id));
    expect(pausedRow[0]).toMatchObject({ enabled: false, nextTriggerAt: null, lastDispatch: null });
  }, 20_000);

  it("refuses an account that is not on the allow-list, and writes nothing", async () => {
    const op = await seedAccount();
    tokens.set(op.token, op.userId);
    startApp([randomUUID()]);
    const response = await post(op.agentId, op.token, cronBody);
    expect(response.statusCode).toBe(403);
    expect(await counts()).toEqual({ sessions: 0, schedules: 0 });
  });

  it("conceals another account's agent as 404 even for an allow-listed operator, and writes nothing", async () => {
    const op = await seedAccount();
    const victim = await seedAccount();
    tokens.set(op.token, op.userId);
    startApp([op.userId]);
    const response = await post(victim.agentId, op.token, cronBody);
    expect(response.statusCode).toBe(404);
    expect(await counts()).toEqual({ sessions: 0, schedules: 0 });
    // A deleted agent of the operator's own account is concealed the same way.
    await client.database.update(agents).set({ status: "deleted" }).where(eq(agents.id, op.agentId));
    expect((await post(op.agentId, op.token, cronBody)).statusCode).toBe(404);
  });

  it("explains a missing IM binding / missing computer / suspended agent as 409 and writes nothing", async () => {
    const noBinding = await seedAccount({ binding: false });
    const noComputer = await seedAccount({ computer: false });
    const suspended = await seedAccount();
    await client.database.update(agents).set({ status: "suspended" }).where(eq(agents.id, suspended.agentId));
    for (const account of [noBinding, noComputer, suspended]) tokens.set(account.token, account.userId);
    startApp([noBinding.userId, noComputer.userId, suspended.userId]);

    const a = await post(noBinding.agentId, noBinding.token, cronBody);
    expect([a.statusCode, a.json().error.code]).toEqual([409, "SCHEDULE_TARGET_REQUIRED"]);
    const b = await post(noComputer.agentId, noComputer.token, cronBody);
    expect([b.statusCode, b.json().error.code]).toEqual([409, "SCHEDULE_TARGET_INVALID"]);
    const c = await post(suspended.agentId, suspended.token, cronBody);
    expect([c.statusCode, c.json().error.code]).toEqual([409, "SCHEDULE_TARGET_INVALID"]);
    expect(await counts()).toEqual({ sessions: 0, schedules: 0 });
  });

  it("refuses invalid rules with the upstream error codes and creates no schedule", async () => {
    const op = await seedAccount();
    tokens.set(op.token, op.userId);
    startApp([op.userId]);
    const badCron = await post(op.agentId, op.token, {
      ...cronBody,
      schedule: { kind: "cron", expression: "99 99 * * *" },
    });
    expect([badCron.statusCode, badCron.json().error.code]).toEqual([400, "SCHEDULE_INVALID_RULE"]);
    const badZone = await post(op.agentId, op.token, { ...cronBody, timezone: "Mars/Olympus" });
    expect([badZone.statusCode, badZone.json().error.code]).toEqual([400, "SCHEDULE_INVALID_TIMEZONE"]);
    const past = await post(op.agentId, op.token, {
      ...cronBody,
      schedule: { kind: "at", at: "2020-01-01T00:00:00Z" },
      timezone: "UTC",
    });
    expect([past.statusCode, past.json().error.code]).toEqual([409, "SCHEDULE_NO_FUTURE_OCCURRENCE"]);
    expect((await counts()).schedules).toBe(0);
  });
});
