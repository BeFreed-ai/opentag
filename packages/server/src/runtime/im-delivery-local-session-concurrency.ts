import { RUNTIME_CAPABILITY } from "@opentag/shared";
import type { DatabaseClient } from "../db/client.js";
import type { ConnectionRegistry } from "./connection-registry.js";
import { hasOtherCustody, type LocalSessionConcurrencyPolicy } from "./im-delivery-custody.js";

export type LocalSessionConcurrencyContext = {
  computerId: string | undefined;
  computerInstanceId?: string | undefined;
  computerKind: "local" | "cloud" | undefined;
};

export function localSessionConcurrencyFor(
  registry: ConnectionRegistry,
  limits: ReadonlyMap<string, number>,
  context: LocalSessionConcurrencyContext,
): LocalSessionConcurrencyPolicy | undefined {
  if (context.computerKind !== "local" || !context.computerId) return undefined;
  const maxConcurrent = limits.get(context.computerId);
  if (maxConcurrent === undefined) return undefined;
  const instanceId = registry.currentInstanceId(context.computerId);
  if (context.computerInstanceId !== undefined && context.computerInstanceId !== instanceId) return undefined;
  if (
    !instanceId ||
    !registry.supportsCapability(context.computerId, instanceId, RUNTIME_CAPABILITY.localSessionConcurrency)
  )
    return undefined;
  return { maxConcurrent };
}

type LocalDeliveryRow = {
  agent: { id: string };
  computer: { currentInstanceId: string | null; id: string; kind: "local" | "cloud" };
  session: { id: string };
};

export type LocalDeliveryTarget = { expectedConnectionId?: string; instanceId: string };

/** Bind a parallel Local delivery to its current, capability-negotiated connection. */
export async function resolveLocalDeliveryTarget(input: {
  database: DatabaseClient;
  deliveryId: string;
  claimToken: string;
  limits: ReadonlyMap<string, number>;
  recordFailure: (deliveryId: string, code: string, claimToken: string) => Promise<void>;
  registry: ConnectionRegistry;
  row: LocalDeliveryRow;
}): Promise<LocalDeliveryTarget | undefined> {
  const { database, deliveryId, claimToken, limits, recordFailure, registry, row } = input;
  const instanceId = registry.currentInstanceId(row.computer.id);
  if (!instanceId || row.computer.currentInstanceId !== instanceId) {
    await recordFailure(deliveryId, "IM_DELIVERY_RUNTIME_UNAVAILABLE", claimToken);
    return undefined;
  }
  const localSessionConcurrency = localSessionConcurrencyFor(registry, limits, {
    computerId: row.computer.id,
    computerInstanceId: instanceId,
    computerKind: row.computer.kind,
  });
  if (
    await hasOtherCustody(
      database,
      {
        deliveryId,
        agentId: row.agent.id,
        sessionId: row.session.id,
        computerKind: row.computer.kind,
      },
      localSessionConcurrency,
    )
  ) {
    await recordFailure(deliveryId, "IM_DELIVERY_AGENT_CUSTODY_FENCED", claimToken);
    return undefined;
  }
  const expectedConnectionId = localSessionConcurrency
    ? registry.currentConnectionId(row.computer.id, instanceId)
    : undefined;
  if (localSessionConcurrency && !expectedConnectionId) {
    await recordFailure(deliveryId, "IM_DELIVERY_RUNTIME_UNAVAILABLE", claimToken);
    return undefined;
  }
  return { instanceId, expectedConnectionId };
}
