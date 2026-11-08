/*
 * BeFreed fork: HTTP contract of the operator-only Schedule creation route. The service is stubbed; what is
 * under test is the wire behavior: the route does not exist unless it is registered, authentication comes
 * first, the operator allow-list is enforced before any body is read, the strict body schema, and the audit
 * line (which must never contain the prompt or any credential).
 */

import { randomUUID } from "node:crypto";
import { AGENT_SCHEDULE_PROMPT_MAX_BYTES, type AgentSchedule } from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { resourceNotFound } from "../services/agents/errors.js";
import { invalidCredential } from "../services/auth/errors.js";
import type { UserAuthService } from "../services/auth/index.js";
import { ScheduleServiceError } from "../services/schedules/index.js";

const operatorId = randomUUID();
const otherUserId = randomUUID();
const agentId = randomUUID();
const sessionId = randomUUID();
const now = "2026-11-08T01:00:00.000Z";
const SECRET_PROMPT = "PROMPT-BODY-MUST-NOT-BE-LOGGED";

const created: AgentSchedule = {
  id: randomUUID(),
  agentId,
  target: { sessionId, provider: "slack", sessionKind: "channel", channelId: "D123", threadKey: null },
  name: "Daily SEO",
  prompt: SECRET_PROMPT,
  schedule: { kind: "cron", expression: "0 9 * * *" },
  timezone: "America/Los_Angeles",
  enabled: true,
  nextTriggerAt: "2026-11-08T17:00:00.000Z",
  revision: 1,
  lastDispatch: null,
  detailUrl: `https://opentag.example.com/agents/${agentId}`,
  createdAt: now,
  updatedAt: now,
};

const validBody = {
  channelId: "D123",
  conversationKind: "dm",
  name: "Daily SEO",
  prompt: SECRET_PROMPT,
  schedule: { kind: "cron", expression: "0 9 * * *" },
  timezone: "America/Los_Angeles",
};

const url = `/api/v1/operator/agents/${agentId}/schedules`;
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function fixture(options: { register?: boolean; allowed?: string[]; createSchedule?: ReturnType<typeof vi.fn> } = {}) {
  const service = { createSchedule: options.createSchedule ?? vi.fn(async () => created) };
  const logger = { info: vi.fn(), warn: vi.fn() };
  const authService = {
    getAuthenticatedUser: vi.fn(async (token: string) => {
      if (token === "operator-token" || token === "other-token") {
        return {
          tokenExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
          me: {
            user: {
              id: token === "operator-token" ? operatorId : otherUserId,
              email: "x@example.com",
              displayName: "X",
            },
            setupCompletedAt: null,
          },
        };
      }
      throw invalidCredential("AUTH_INVALID_TOKEN", "Authentication is required");
    }),
  } as unknown as UserAuthService;
  const app = createApp({
    authService,
    ...(options.register === false
      ? {}
      : {
          operatorSchedules: {
            service: service as never,
            allowedUserIds: new Set(options.allowed ?? [operatorId]),
            logger,
          },
        }),
  });
  apps.push(app);
  return { app, service, logger };
}

describe("operator schedule route", () => {
  it("does not exist when it is not registered (flag off)", async () => {
    const { app } = fixture({ register: false });
    const response = await app.inject({ method: "POST", url, headers: bearer("operator-token"), payload: validBody });
    expect(response.statusCode).toBe(404);
  });

  it("requires authentication", async () => {
    const { app, service } = fixture();
    const none = await app.inject({ method: "POST", url, payload: validBody });
    const bad = await app.inject({ method: "POST", url, headers: bearer("nope"), payload: validBody });
    expect([none.statusCode, bad.statusCode]).toEqual([401, 401]);
    expect(service.createSchedule).not.toHaveBeenCalled();
  });

  it("refuses an authenticated account that is not on the allow-list, before reading the body", async () => {
    const { app, service, logger } = fixture();
    const response = await app.inject({
      method: "POST",
      url,
      headers: bearer("other-token"),
      payload: { garbage: true },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("AGENT_FORBIDDEN");
    expect(service.createSchedule).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "operator.schedule.denied",
        operatorUserId: otherUserId,
        reason: "not_allow_listed",
      }),
      "operator.schedule.denied",
    );
  });

  it("creates a cron schedule for an allow-listed operator and writes one audit line without the prompt", async () => {
    const { app, service, logger } = fixture();
    const response = await app.inject({ method: "POST", url, headers: bearer("operator-token"), payload: validBody });
    expect(response.statusCode).toBe(201);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual(created);
    expect(service.createSchedule).toHaveBeenCalledWith(operatorId, agentId, {
      channelId: "D123",
      conversationKind: "dm",
      name: "Daily SEO",
      prompt: SECRET_PROMPT,
      enabled: true,
      schedule: { kind: "cron", expression: "0 9 * * *" },
      timezone: "America/Los_Angeles",
    });
    expect(logger.info).toHaveBeenCalledTimes(1);
    const line = JSON.stringify([...logger.info.mock.calls, ...logger.warn.mock.calls]);
    expect(line).toContain("operator.schedule.created");
    expect(line).not.toContain(SECRET_PROMPT);
    expect(line).not.toContain("operator-token");
  });

  it("accepts a one-time at rule and the run-now parameter (mirror cases)", async () => {
    const { app, service } = fixture();
    const at = await app.inject({
      method: "POST",
      url,
      headers: bearer("operator-token"),
      payload: { ...validBody, schedule: { kind: "at", at: "2030-01-01T00:00:00Z" }, timezone: "UTC", enabled: false },
    });
    expect(at.statusCode).toBe(201);
    expect(service.createSchedule).toHaveBeenLastCalledWith(
      operatorId,
      agentId,
      expect.objectContaining({ schedule: { kind: "at", at: "2030-01-01T00:00:00Z" }, enabled: false }),
    );
    const { schedule: _s, timezone: _t, ...base } = validBody;
    const runNow = await app.inject({
      method: "POST",
      url,
      headers: bearer("operator-token"),
      payload: { ...base, runInSeconds: 10 },
    });
    expect(runNow.statusCode).toBe(201);
    expect(service.createSchedule).toHaveBeenLastCalledWith(
      operatorId,
      agentId,
      expect.objectContaining({ runInSeconds: 10, enabled: true }),
    );
  });

  it.each([
    ["both schedule and runInSeconds", { runInSeconds: 10 }],
    ["neither schedule nor runInSeconds", { schedule: undefined, timezone: undefined }],
    ["schedule without timezone", { timezone: undefined }],
    ["runInSeconds too small", { schedule: undefined, timezone: undefined, runInSeconds: 1 }],
    ["run-now created disabled", { schedule: undefined, timezone: undefined, runInSeconds: 10, enabled: false }],
    ["unknown field", { target: "x" }],
    ["empty name", { name: "  " }],
    ["prompt over 16 KiB", { prompt: "a".repeat(AGENT_SCHEDULE_PROMPT_MAX_BYTES + 1) }],
    ["empty prompt", { prompt: "" }],
    ["bad conversationKind", { conversationKind: "everything" }],
  ])("refuses an invalid body: %s", async (_label, patch) => {
    const { app, service } = fixture();
    const response = await app.inject({
      method: "POST",
      url,
      headers: bearer("operator-token"),
      payload: { ...validBody, ...patch },
    });
    expect(response.statusCode).toBe(400);
    expect(service.createSchedule).not.toHaveBeenCalled();
  });

  it("refuses a non-UUID agent id", async () => {
    const { app, service } = fixture();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/operator/agents/not-a-uuid/schedules",
      headers: bearer("operator-token"),
      payload: validBody,
    });
    expect(response.statusCode).toBe(400);
    expect(service.createSchedule).not.toHaveBeenCalled();
  });

  it("surfaces concealed ownership failures and rule failures from the service, and audits the failure", async () => {
    const notOwned = fixture({ createSchedule: vi.fn(async () => Promise.reject(resourceNotFound())) });
    const missing = await notOwned.app.inject({
      method: "POST",
      url,
      headers: bearer("operator-token"),
      payload: validBody,
    });
    expect(missing.statusCode).toBe(404);
    expect(notOwned.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "operator.schedule.failed", code: "RESOURCE_NOT_FOUND" }),
      "operator.schedule.failed",
    );
    const badRule = fixture({
      createSchedule: vi.fn(async () => Promise.reject(new ScheduleServiceError("SCHEDULE_INVALID_RULE", "bad cron"))),
    });
    const rule = await badRule.app.inject({
      method: "POST",
      url,
      headers: bearer("operator-token"),
      payload: validBody,
    });
    expect(rule.statusCode).toBe(400);
    expect(rule.json().error.code).toBe("SCHEDULE_INVALID_RULE");
  });
});
