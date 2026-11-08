/*
 * BeFreed fork: unit tests for OperatorScheduleService and the operatorSchedulesOption wiring. The service
 * runs against the real PostgreSQL dialect (PGlite) for the ownership and binding lookups; the session and
 * schedule services are stubbed, so no network and no real IM provider is involved.
 */

import { randomUUID } from "node:crypto";
import { type AgentSchedule, SCHEDULE_ERROR_CODES } from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, computers, imBindings, users } from "../db/schema/index.js";
import { operatorSchedulesOption, parseOperatorRoutesConfig } from "../operator-routes-config.js";
import { AgentServiceError } from "../services/agents/errors.js";
import { ScheduleServiceError } from "../services/schedules/errors.js";
import { OperatorScheduleService } from "../services/schedules/operator-service.js";
import { SessionServiceError } from "../services/sessions/session-service.js";
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

const FIXED_NOW = new Date("2026-11-08T01:00:00.000Z");
const SECRET_PROMPT = "PROMPT-BODY-MUST-NOT-LEAK";

async function seed(options: { withBinding?: boolean } = {}) {
  const accountId = randomUUID();
  const computerId = randomUUID();
  const agentId = randomUUID();
  const bindingId = randomUUID();
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
  if (options.withBinding !== false) {
    await db.database.insert(imBindings).values({
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
  return { accountId, agentId, bindingId };
}

function harness() {
  const sessionId = randomUUID();
  const sessions = { ensureChatSession: vi.fn(async () => ({ session: { id: sessionId } }) as never) };
  const createForAgent = vi.fn(
    async (_scope: unknown, input: { name: string }) => ({ id: randomUUID(), revision: 1, name: input.name }) as never,
  );
  const pauseForAgent = vi.fn(async () => ({ paused: true }) as never as AgentSchedule);
  const service = new OperatorScheduleService({
    database: db.database,
    sessions,
    schedules: { createForAgent, pauseForAgent } as never,
    clock: { now: async () => FIXED_NOW },
  });
  return { service, sessions, createForAgent, pauseForAgent, sessionId };
}

const cronInput = {
  channelId: "D123",
  conversationKind: "dm" as const,
  name: "Daily SEO",
  prompt: SECRET_PROMPT,
  schedule: { kind: "cron" as const, expression: "0 9 * * *" },
  timezone: "America/Los_Angeles",
  enabled: true,
};

describe("OperatorScheduleService.createSchedule (BeFreed fork)", () => {
  it("creates through the upstream ScheduleService with a scope built from the owned agent", async () => {
    const { accountId, agentId, bindingId } = await seed();
    const h = harness();
    const result = await h.service.createSchedule(accountId, agentId, cronInput);

    expect(h.sessions.ensureChatSession).toHaveBeenCalledWith(
      { imBindingId: bindingId, channelId: "D123", conversationKind: "dm" },
      "channel",
    );
    expect(h.createForAgent).toHaveBeenCalledWith(
      { accountId, agentId, sessionId: h.sessionId, sessionKind: "channel" },
      { name: "Daily SEO", prompt: SECRET_PROMPT, schedule: cronInput.schedule, timezone: "America/Los_Angeles" },
    );
    expect(h.pauseForAgent).not.toHaveBeenCalled();
    expect(result).toMatchObject({ name: "Daily SEO", revision: 1 });
  });

  it("conceals an agent owned by another account as not found, before touching sessions", async () => {
    const owner = await seed();
    const h = harness();
    await expect(h.service.createSchedule(randomUUID(), owner.agentId, cronInput)).rejects.toMatchObject({
      statusCode: 404,
      code: "RESOURCE_NOT_FOUND",
    });
    await expect(h.service.createSchedule(randomUUID(), owner.agentId, cronInput)).rejects.toBeInstanceOf(
      AgentServiceError,
    );
    expect(h.sessions.ensureChatSession).not.toHaveBeenCalled();
    expect(h.createForAgent).not.toHaveBeenCalled();
  });

  it("treats a missing or deleted agent as not found", async () => {
    const h = harness();
    await expect(h.service.createSchedule(randomUUID(), randomUUID(), cronInput)).rejects.toMatchObject({
      statusCode: 404,
    });
    const owner = await seed();
    await db.database.update(agents).set({ status: "deleted" }).where(eq(agents.id, owner.agentId));
    await expect(h.service.createSchedule(owner.accountId, owner.agentId, cronInput)).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(h.createForAgent).not.toHaveBeenCalled();
  });

  it("refuses an agent with no active IM binding", async () => {
    const { accountId, agentId } = await seed({ withBinding: false });
    const h = harness();
    await expect(h.service.createSchedule(accountId, agentId, cronInput)).rejects.toMatchObject({
      code: SCHEDULE_ERROR_CODES.TARGET_REQUIRED,
    });
    expect(h.createForAgent).not.toHaveBeenCalled();
  });

  it("ignores a binding that is not active", async () => {
    const { accountId, agentId } = await seed();
    await db.database
      .update(imBindings)
      .set({ status: "reauthorization_required" })
      .where(eq(imBindings.agentId, agentId));
    const h = harness();
    await expect(h.service.createSchedule(accountId, agentId, cronInput)).rejects.toMatchObject({
      code: SCHEDULE_ERROR_CODES.TARGET_REQUIRED,
    });
  });

  it("maps a session failure to TARGET_INVALID and rethrows anything else untouched", async () => {
    const { accountId, agentId } = await seed();
    const h = harness();
    h.sessions.ensureChatSession.mockRejectedValueOnce(new SessionServiceError("X", "agent has no computer"));
    const failure = await h.service.createSchedule(accountId, agentId, cronInput).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ScheduleServiceError);
    expect(failure).toMatchObject({ code: SCHEDULE_ERROR_CODES.TARGET_INVALID, message: "agent has no computer" });

    const boom = new Error("database down");
    h.sessions.ensureChatSession.mockRejectedValueOnce(boom);
    await expect(h.service.createSchedule(accountId, agentId, cronInput)).rejects.toBe(boom);
    expect(h.createForAgent).not.toHaveBeenCalled();
  });

  it("turns runInSeconds into a one-shot UTC schedule relative to the database clock", async () => {
    const { accountId, agentId } = await seed();
    const h = harness();
    const { schedule: _omit, timezone: _tz, ...rest } = cronInput;
    await h.service.createSchedule(accountId, agentId, { ...rest, runInSeconds: 90 });
    expect(h.createForAgent).toHaveBeenCalledWith(expect.anything(), {
      name: "Daily SEO",
      prompt: SECRET_PROMPT,
      schedule: { kind: "at", at: "2026-11-08T01:01:30.000Z" },
      timezone: "UTC",
    });
  });

  it("fails closed when neither a schedule nor runInSeconds is given", async () => {
    const { accountId, agentId } = await seed();
    const h = harness();
    const { schedule: _omit, timezone: _tz, ...rest } = cronInput;
    await expect(h.service.createSchedule(accountId, agentId, rest)).rejects.toThrow(/runInSeconds is required/);
    expect(h.createForAgent).not.toHaveBeenCalled();
  });

  it("creates disabled by pausing the new schedule at its revision", async () => {
    const { accountId, agentId } = await seed();
    const h = harness();
    const result = await h.service.createSchedule(accountId, agentId, { ...cronInput, enabled: false });
    expect(h.pauseForAgent).toHaveBeenCalledWith(
      { accountId, agentId, sessionId: h.sessionId, sessionKind: "channel" },
      expect.any(String),
      1,
    );
    expect(result).toEqual({ paused: true });
  });

  it("uses the real database clock when none is injected", async () => {
    const { accountId, agentId } = await seed();
    const h = harness();
    const service = new OperatorScheduleService({
      database: db.database,
      sessions: h.sessions,
      schedules: { createForAgent: h.createForAgent, pauseForAgent: h.pauseForAgent } as never,
    });
    const { schedule: _omit, timezone: _tz, ...rest } = cronInput;
    const before = Date.now();
    await service.createSchedule(accountId, agentId, { ...rest, runInSeconds: 60 });
    const call = h.createForAgent.mock.calls[0] as unknown as [unknown, { schedule: { at: string } }];
    const at = new Date(call[1].schedule.at).getTime();
    expect(at).toBeGreaterThanOrEqual(before + 59_000);
    expect(at).toBeLessThan(before + 120_000);
  });
});

describe("operatorSchedulesOption (BeFreed fork)", () => {
  const A = "11111111-1111-4111-8111-111111111111";
  const deps = () => ({
    database: db.database,
    sessions: {} as never,
    schedules: {} as never,
    logger: { info: vi.fn(), warn: vi.fn() } as never,
  });

  it("registers nothing when the flag is off, so the route does not exist", () => {
    expect(operatorSchedulesOption(parseOperatorRoutesConfig({}), deps())).toEqual({});
    expect(
      operatorSchedulesOption(
        parseOperatorRoutesConfig({ OPENTAG_OPERATOR_ROUTES_ENABLED: "false", OPENTAG_OPERATOR_USER_IDS: A }),
        deps(),
      ),
    ).toEqual({});
  });

  it("wires the service and exactly the configured allow-list when the flag is on", () => {
    const option = operatorSchedulesOption(
      parseOperatorRoutesConfig({ OPENTAG_OPERATOR_ROUTES_ENABLED: "true", OPENTAG_OPERATOR_USER_IDS: A }),
      deps(),
    );
    expect(option.operatorSchedules?.service).toBeInstanceOf(OperatorScheduleService);
    expect([...(option.operatorSchedules?.allowedUserIds ?? [])]).toEqual([A]);
  });
});
