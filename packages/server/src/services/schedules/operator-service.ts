/*
 * BeFreed modification (Apache-2.0 section 4(b)): this file is new in the BeFreed fork. It is not part of
 * upstream OpenTag. See BEFREED.md.
 */
import {
  type AgentSchedule,
  type AgentScheduleInput,
  type ImConversationKind,
  type RuntimeUserTaskSource,
  SCHEDULE_ERROR_CODES,
} from "@opentag/shared";
import { and, desc, eq, isNotNull, ne } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import { agents, imBindings, imMessageDeliveries, imMessages } from "../../db/schema/index.js";
import { resourceNotFound } from "../agents/errors.js";
import { type SessionService, SessionServiceError } from "../sessions/session-service.js";
import { ScheduleServiceError } from "./errors.js";
import { type AgentScheduleScope, type ScheduleClock, type ScheduleService, scheduleDatabaseClock } from "./service.js";

/*
 * OperatorScheduleService — account-level Schedule creation for the platform operator.
 *
 * Upstream creates a Schedule only from inside an Agent's own turn: the Session CLI proof names the
 * target conversation. This service lets an authorized operator Account create one from outside, for an
 * Agent the Account owns, with NO inbound IM message:
 *
 *  1. the Agent must be owned by the calling Account and not deleted (anything else is concealed as 404,
 *     exactly like the Account list/show routes);
 *  2. the Agent must have an active IM binding (a Session always hangs off one);
 *  3. the target channel Session is found or created through `SessionService.ensureChatSession`, which
 *     itself requires an active Agent bound to a Computer;
 *  4. the Schedule is then created through `ScheduleService.createForAgent` with a scope built here, so
 *     rule grammar, timezone, future-occurrence and prompt-size validation, the transaction, the revision
 *     and the audit event are all the upstream code path, not a copy.
 *
 * Authorization of the CALLER (flag + operator allow-list) is the route's job, not this service's.
 */

export interface OperatorCreateScheduleInput {
  channelId: string;
  conversationKind: ImConversationKind;
  name: string;
  prompt: string;
  /** Exactly one of `schedule` (+`timezone`) and `runInSeconds` is set; the route's schema enforces it. */
  schedule?: AgentScheduleInput;
  timezone?: string;
  /** Run once, this many seconds after the database clock now. */
  runInSeconds?: number;
  enabled: boolean;
  /**
   * Create the Schedule on behalf of a real Slack human. The Server never trusts the caller for the
   * provenance: it looks up an accepted inbound human message of this user in this channel itself.
   */
  onBehalfOf?: { slackUserId: string };
}

export interface OperatorScheduleServiceOptions {
  database: DatabaseClient;
  sessions: Pick<SessionService, "ensureChatSession">;
  schedules: Pick<ScheduleService, "createForAgent" | "pauseForAgent">;
  clock?: ScheduleClock;
}

export class OperatorScheduleService {
  readonly #options: OperatorScheduleServiceOptions;
  readonly #clock: ScheduleClock;

  constructor(options: OperatorScheduleServiceOptions) {
    this.#options = options;
    this.#clock = options.clock ?? scheduleDatabaseClock;
  }

  async createSchedule(accountId: string, agentId: string, input: OperatorCreateScheduleInput): Promise<AgentSchedule> {
    const { database, sessions, schedules } = this.#options;
    const [owned] = await database
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.createdByUserId, accountId), ne(agents.status, "deleted")))
      .limit(1);
    if (!owned) throw resourceNotFound();

    const [binding] = await database
      .select({ id: imBindings.id, provider: imBindings.provider, externalBotId: imBindings.externalBotId })
      .from(imBindings)
      .where(and(eq(imBindings.agentId, agentId), eq(imBindings.status, "active")))
      .limit(1);
    if (!binding) {
      throw new ScheduleServiceError(
        SCHEDULE_ERROR_CODES.TARGET_REQUIRED,
        "The agent has no active IM binding; bind it to Slack or Feishu first",
      );
    }

    let sessionId: string;
    try {
      const { session } = await sessions.ensureChatSession(
        { imBindingId: binding.id, channelId: input.channelId, conversationKind: input.conversationKind },
        "channel",
      );
      sessionId = session.id;
    } catch (error) {
      if (error instanceof SessionServiceError) {
        throw new ScheduleServiceError(SCHEDULE_ERROR_CODES.TARGET_INVALID, error.message);
      }
      throw error;
    }

    let schedule = input.schedule;
    let timezone = input.timezone;
    if (input.runInSeconds !== undefined) {
      const now = await this.#clock.now(database);
      schedule = { kind: "at", at: new Date(now.getTime() + input.runInSeconds * 1000).toISOString() };
      timezone = "UTC";
    }
    if (!schedule || !timezone) throw new Error("A schedule or runInSeconds is required");

    const userTaskSource = input.onBehalfOf
      ? await this.#resolveOnBehalfSource(binding, sessionId, input.channelId, input.onBehalfOf.slackUserId)
      : undefined;
    const scope: AgentScheduleScope = {
      accountId,
      agentId,
      sessionId,
      sessionKind: "channel",
      ...(userTaskSource ? { userTaskSource } : {}),
    };
    const created = await schedules.createForAgent(scope, {
      name: input.name,
      prompt: input.prompt,
      schedule,
      timezone,
    });
    if (input.enabled) return created;
    return schedules.pauseForAgent(scope, created.id, created.revision);
  }

  /**
   * Provenance for a Schedule created on behalf of a Slack user: the newest accepted inbound human message of
   * that user in this very channel Session of this binding. Any miss is a 409; it never falls back to no source.
   */
  async #resolveOnBehalfSource(
    binding: { id: string; provider: string; externalBotId: string | null },
    sessionId: string,
    channelId: string,
    slackUserId: string,
  ): Promise<RuntimeUserTaskSource> {
    const notVerified = (reason: string) =>
      new ScheduleServiceError(SCHEDULE_ERROR_CODES.ON_BEHALF_NOT_VERIFIED, `onBehalfOf is not verified: ${reason}`);
    if (binding.provider !== "slack") throw notVerified("only Slack bindings are supported");
    if (slackUserId === binding.externalBotId) throw notVerified("the user is the agent's own bot");
    const [row] = await this.#options.database
      .select({ deliveryId: imMessageDeliveries.id, turnId: imMessageDeliveries.turnId })
      .from(imMessageDeliveries)
      .innerJoin(imMessages, eq(imMessages.id, imMessageDeliveries.messageId))
      .where(
        and(
          eq(imMessageDeliveries.sessionId, sessionId),
          eq(imMessageDeliveries.state, "accepted"),
          isNotNull(imMessageDeliveries.turnId),
          eq(imMessages.imBindingId, binding.id),
          eq(imMessages.channelId, channelId),
          eq(imMessages.direction, "inbound"),
          eq(imMessages.authorKind, "human"),
          eq(imMessages.authorExternalId, slackUserId),

        ),
      )
      .orderBy(desc(imMessages.occurredAt))
      .limit(1);
    if (!row?.turnId) throw notVerified("no accepted message from this user in this channel");
    return { sessionId, source: { kind: "delivery", deliveryId: row.deliveryId, turnId: row.turnId } };
  }
}
