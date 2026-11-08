/*
 * BeFreed modification (Apache-2.0 section 4(b)): this file is new in the BeFreed fork. It is not part of
 * upstream OpenTag. See BEFREED.md.
 */
import {
  AgentScheduleInputSchema,
  AgentScheduleNameSchema,
  AgentSchedulePromptSchema,
  AgentScheduleSchema,
  AgentScheduleTimezoneSchema,
  ImConversationKindSchema,
} from "@opentag/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ServiceLogger } from "../observability/service-logger.js";
import { createUserAuthPreHandler, type UserAuthPreHandlerOptions } from "../plugins/user-auth.js";
import { AgentServiceError } from "../services/agents/index.js";
import type { UserAuthService } from "../services/auth/index.js";
import type { OperatorScheduleService } from "../services/schedules/operator-service.js";
import { parseRequest } from "./request-validation.js";

/*
 * Operator-only Schedule creation: `POST /api/v1/operator/agents/:agentId/schedules`.
 *
 * Registered ONLY when the deployment turns it on (`OPENTAG_OPERATOR_ROUTES_ENABLED=true`); otherwise the
 * path does not exist and the Server answers 404. When registered, a call must pass, in this order:
 *
 *  1. Account authentication with a Bearer token (the platform account token). A browser cookie session is
 *     refused: this route is for scripts, never for the Web App.
 *  2. The operator allow-list (`OPENTAG_OPERATOR_USER_IDS`): the authenticated user id must be listed.
 *  3. Body validation (strict schema), then the service: the Agent must belong to the caller's Account.
 *
 * Each call writes one audit log line with the operator, the Agent and the outcome. It never contains the
 * prompt, the token or any header.
 */

export const OPERATOR_AGENT_SCHEDULES_TEMPLATE = "/api/v1/operator/agents/:agentId/schedules";
export const OPERATOR_RUN_IN_SECONDS_MIN = 5;
export const OPERATOR_RUN_IN_SECONDS_MAX = 3600;

const ParamsSchema = z.object({ agentId: z.string().uuid() }).strict();

export const OperatorCreateScheduleRequestSchema = z
  .object({
    channelId: z.string().min(1).max(512),
    conversationKind: ImConversationKindSchema,
    name: AgentScheduleNameSchema,
    prompt: AgentSchedulePromptSchema,
    /** A cron or one-time `at` rule, same shape as the runtime route. */
    schedule: AgentScheduleInputSchema.optional(),
    timezone: AgentScheduleTimezoneSchema.optional(),
    /** "Run now": one run this many seconds from now, computed on the Server's database clock. */
    runInSeconds: z.number().int().min(OPERATOR_RUN_IN_SECONDS_MIN).max(OPERATOR_RUN_IN_SECONDS_MAX).optional(),
    enabled: z.boolean().default(true),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.schedule === undefined) === (value.runInSeconds === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["schedule"],
        message: "Provide exactly one of schedule or runInSeconds",
      });
    }
    if (value.schedule !== undefined && value.timezone === undefined) {
      context.addIssue({ code: "custom", path: ["timezone"], message: "timezone is required with schedule" });
    }
    if (value.runInSeconds !== undefined && value.timezone !== undefined) {
      context.addIssue({ code: "custom", path: ["timezone"], message: "timezone is not used with runInSeconds" });
    }
    if (value.runInSeconds !== undefined && !value.enabled) {
      context.addIssue({ code: "custom", path: ["enabled"], message: "A run-now schedule cannot be created disabled" });
    }
  });

export interface OperatorScheduleRoutesOptions {
  service: Pick<OperatorScheduleService, "createSchedule">;
  allowedUserIds: ReadonlySet<string>;
  logger?: Pick<ServiceLogger, "info" | "warn">;
  authOptions?: UserAuthPreHandlerOptions;
}

/** A no-op when `options` is absent: the route then does not exist. */
export function registerOperatorScheduleRoutes(
  app: FastifyInstance,
  authService: UserAuthService,
  options: OperatorScheduleRoutesOptions | undefined,
  authOptions?: UserAuthPreHandlerOptions,
): void {
  if (!options) return;
  const preHandler = createUserAuthPreHandler(authService, authOptions ?? options.authOptions ?? {});
  const { service, logger } = options;
  const allowed = new Set([...options.allowedUserIds].map((id) => id.toLowerCase()));

  app.post(OPERATOR_AGENT_SCHEDULES_TEMPLATE, { preHandler }, async (request, reply) => {
    const operatorUserId = authorizeOperator(request, allowed, logger);
    const { agentId } = parseRequest(ParamsSchema, request.params);
    const input = parseRequest(OperatorCreateScheduleRequestSchema, request.body);
    try {
      const created = AgentScheduleSchema.parse(await service.createSchedule(operatorUserId, agentId, input));
      logger?.info(
        {
          event: "operator.schedule.created",
          operatorUserId,
          agentId,
          scheduleId: created.id,
          ruleKind: created.schedule.kind,
          enabled: created.enabled,
        },
        "operator.schedule.created",
      );
      return reply.header("Cache-Control", "no-store").code(201).send(created);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      logger?.warn(
        {
          event: "operator.schedule.failed",
          operatorUserId,
          agentId,
          code: typeof code === "string" ? code : "internal",
        },
        "operator.schedule.failed",
      );
      throw error;
    }
  });
}

/** Bearer-only, allow-listed callers pass; everyone else is a 403 and one audit line. Returns the operator's user id. */
function authorizeOperator(
  request: FastifyRequest,
  allowed: ReadonlySet<string>,
  logger: Pick<ServiceLogger, "warn"> | undefined,
): string {
  const operatorUserId = request.authContext?.me.user.id;
  if (!operatorUserId) throw new Error("Authenticated user context is missing");
  const agentIdParam = (request.params as { agentId?: unknown } | undefined)?.agentId;
  const reason = !bearerPresent(request)
    ? "bearer_required"
    : !allowed.has(operatorUserId.toLowerCase())
      ? "not_allow_listed"
      : undefined;
  if (reason) {
    logger?.warn(
      {
        event: "operator.schedule.denied",
        operatorUserId,
        agentId: typeof agentIdParam === "string" ? agentIdParam : undefined,
        reason,
      },
      "operator.schedule.denied",
    );
    throw new AgentServiceError("AGENT_FORBIDDEN", "deterministic", "This account is not an authorized operator", 403);
  }
  return operatorUserId;
}

function bearerPresent(request: FastifyRequest): boolean {
  return request.headers.authorization?.startsWith("Bearer ") === true;
}
