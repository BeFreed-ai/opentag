import {
  computeRuntimeImSteerInputHash,
  DirectImMessageDeliveryRequestSchema,
  RuntimeImSteerRequestSchema,
} from "@opentag/shared";
import { and, eq, isNotNull, ne, or, sql } from "drizzle-orm";
import type { DatabaseTransaction } from "../db/client.js";
import { imMessageDeliveries } from "../db/schema/index.js";
import type { lockEligibleDelivery } from "./im-delivery-selector.js";

type LockedDeliveryRow = NonNullable<Awaited<ReturnType<typeof lockEligibleDelivery>>>["row"];

export function staleDispatchGeneration(row: LockedDeliveryRow): boolean {
  const parsed = DirectImMessageDeliveryRequestSchema.safeParse(row.dispatchPayload);
  const steer = RuntimeImSteerRequestSchema.safeParse(row.dispatchPayload);
  const generation = parsed.success
    ? parsed.data.placementGeneration
    : steer.success
      ? steer.data.placementGeneration
      : undefined;
  return (
    row.dispatchRequestId !== null &&
    (row.deliveryGeneration !== row.generation || (generation !== undefined && generation !== row.generation))
  );
}

export function frozenSteerMatches(row: LockedDeliveryRow): boolean {
  const parsed = RuntimeImSteerRequestSchema.safeParse(row.dispatchPayload);
  if (!parsed.success) return false;
  const request = parsed.data;
  return (
    row.dispatchRequestId === request.requestId &&
    row.dispatchInputHash === computeRuntimeImSteerInputHash(request) &&
    row.steerTargetDeliveryId === request.rootDeliveryId &&
    row.id === request.deliveryId &&
    row.sessionId === request.sessionId &&
    row.agentId === request.agentId
  );
}

export async function recoverableSteerTarget(
  transaction: DatabaseTransaction,
  row: LockedDeliveryRow,
): Promise<boolean> {
  if (!row.steerTargetDeliveryId) return false;
  const [target] = await transaction
    .select({ id: imMessageDeliveries.id })
    .from(imMessageDeliveries)
    .where(
      and(
        eq(imMessageDeliveries.id, row.steerTargetDeliveryId),
        ne(imMessageDeliveries.id, row.id),
        eq(imMessageDeliveries.sessionId, row.sessionId),
        or(
          ne(imMessageDeliveries.state, "accepted"),
          and(
            isNotNull(imMessageDeliveries.reportedAt),
            sql`coalesce(${imMessageDeliveries.turnReport} ->> 'outcome', 'unknown') <> 'completed'`,
          ),
        ),
      ),
    )
    .limit(1);
  return target !== undefined;
}
