/*
 * BeFreed modification (Apache-2.0 section 4(b)): this file is new in the BeFreed fork. It is not part of
 * upstream OpenTag. See BEFREED.md.
 *
 * Configuration of the operator-only routes (`/api/v1/operator/...`).
 *
 * - `OPENTAG_OPERATOR_ROUTES_ENABLED` — default `false`. While it is not exactly `true`, the routes are not
 *   registered at all (the Server answers 404, as for any unknown path).
 * - `OPENTAG_OPERATOR_USER_IDS` — comma-separated user ids (UUIDs) of the platform accounts allowed to call
 *   the routes. Enabling the routes with an empty list is a startup error: an enabled but unreachable route is
 *   a misconfiguration, and silently accepting it would hide a typo in the allow-list.
 *
 * Values never appear in error messages; only the position of a bad entry does.
 */

import type { OperatorScheduleRoutesOptions } from "./api/operator-schedules.js";
import type { DatabaseClient } from "./db/client.js";
import type { ServiceLogger } from "./observability/service-logger.js";
import { OperatorScheduleService } from "./services/schedules/operator-service.js";
import type { ScheduleService } from "./services/schedules/service.js";
import type { SessionService } from "./services/sessions/session-service.js";

export interface OperatorRoutesConfig {
  enabled: boolean;
  allowedUserIds: ReadonlySet<string>;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_OPERATOR_USER_IDS = 16;

export class OperatorRoutesConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperatorRoutesConfigError";
  }
}

export function parseOperatorRoutesConfig(environment: NodeJS.ProcessEnv): OperatorRoutesConfig {
  const flag = (environment.OPENTAG_OPERATOR_ROUTES_ENABLED ?? "").trim();
  if (flag !== "" && flag !== "true" && flag !== "false") {
    throw new OperatorRoutesConfigError("OPENTAG_OPERATOR_ROUTES_ENABLED must be true or false");
  }
  const enabled = flag === "true";
  const ids = new Set<string>();
  const entries = (environment.OPENTAG_OPERATOR_USER_IDS ?? "").split(",");
  for (const [index, entry] of entries.entries()) {
    const candidate = entry.trim();
    if (!candidate) continue;
    if (!UUID_PATTERN.test(candidate)) {
      throw new OperatorRoutesConfigError(`OPENTAG_OPERATOR_USER_IDS entry ${index + 1} must be a user id (UUID)`);
    }
    ids.add(candidate.toLowerCase());
  }
  if (ids.size > MAX_OPERATOR_USER_IDS) {
    throw new OperatorRoutesConfigError(`OPENTAG_OPERATOR_USER_IDS accepts at most ${MAX_OPERATOR_USER_IDS} ids`);
  }
  if (enabled && ids.size === 0) {
    throw new OperatorRoutesConfigError(
      "OPENTAG_OPERATOR_ROUTES_ENABLED=true requires OPENTAG_OPERATOR_USER_IDS to list at least one user id",
    );
  }
  // Disabled means disabled: a leftover allow-list never makes anything reachable.
  return { enabled, allowedUserIds: enabled ? ids : new Set() };
}

/** The `createApp` fragment: empty when the routes are off, so the route does not exist. */
export function operatorSchedulesOption(
  config: OperatorRoutesConfig,
  deps: {
    database: DatabaseClient;
    sessions: SessionService;
    schedules: ScheduleService;
    logger: ServiceLogger;
  },
): { operatorSchedules?: OperatorScheduleRoutesOptions } {
  if (!config.enabled) return {};
  return {
    operatorSchedules: {
      service: new OperatorScheduleService({
        database: deps.database,
        sessions: deps.sessions,
        schedules: deps.schedules,
      }),
      allowedUserIds: config.allowedUserIds,
      logger: deps.logger,
    },
  };
}
