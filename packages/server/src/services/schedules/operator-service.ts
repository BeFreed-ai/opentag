/*
 * BeFreed modification (Apache-2.0 section 4(b)): this file is new in the BeFreed fork. It is not part of
 * upstream OpenTag. See BEFREED.md.
 */
import {
  type AgentSchedule,
  type AgentScheduleInput,
  type ImConversationKind,
  SCHEDULE_ERROR_CODES,
} from "@opentag/shared";
import { and, eq, ne } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import { agents, imBindings } from "../../db/schema/index.js";
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
      .select({ id: imBindings.id })
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

    const scope: AgentScheduleScope = { accountId, agentId, sessionId, sessionKind: "channel" };
    const created = await schedules.createForAgent(scope, {
      name: input.name,
      prompt: input.prompt,
      schedule,
      timezone,
    });
    if (input.enabled) return created;
    return schedules.pauseForAgent(scope, created.id, created.revision);
  }
}
