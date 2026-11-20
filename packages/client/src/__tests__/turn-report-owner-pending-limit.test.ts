import { randomUUID } from "node:crypto";
import { computeTurnResultHash, type TurnReportRequest } from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TurnReportOwner, type TurnReportOwnerOptions } from "../runtime/turn-report-owner.js";
import { ObservedDurabilityStore } from "./support/durable-work-contract.js";

const owners: TurnReportOwner[] = [];
afterEach(async () => {
  for (const owner of owners.splice(0)) {
    owner.stop();
    await owner.settled();
  }
});

function report(turnId: string): TurnReportRequest {
  const input = {
    deliveryId: `delivery-${turnId}`,
    turnId,
    sessionId: "session",
    agentId: "agent",
    placementGeneration: 1,
    outcome: "completed" as const,
    executionEffects: "completed" as const,
    traceSummary: { lastSequence: 0, droppedEvents: 0 },
  };
  return { type: "turn:report", requestId: randomUUID(), ...input, resultHash: computeTurnResultHash(input) };
}

function ownerWithLimit(maxPending: number): TurnReportOwner {
  const connection = {
    state: "registered" as const,
    send: vi.fn(async () => undefined),
    subscribeState(listener: (state: "registered" | "stopped") => void) {
      listener("registered");
      return () => undefined;
    },
  } satisfies TurnReportOwnerOptions["connection"];
  const owner = new TurnReportOwner({
    connection,
    persistence: new ObservedDurabilityStore(),
    maxPending,
    retryPolicy: { baseDelayMs: 100, maxDelayMs: 100, maxAgeMs: 60_000, maxAttempts: 10 },
  });
  owners.push(owner);
  return owner;
}

function submit(owner: TurnReportOwner, request: TurnReportRequest): Promise<void> {
  const pending = owner.submit(request, () => undefined);
  void pending.catch(() => undefined);
  return pending;
}

describe("Turn Report owner pending limit", () => {
  it("refuses a new report while the limit of reports still awaiting the Server is reached", async () => {
    const owner = ownerWithLimit(2);
    await owner.ready();
    void submit(owner, report("turn-1"));
    void submit(owner, report("turn-2"));
    await expect(submit(owner, report("turn-3"))).rejects.toThrow("reached its pending limit");
  });

  it("does not count reports the Server already settled as terminal failures", async () => {
    const owner = ownerWithLimit(2);
    await owner.ready();
    const first = report("turn-1");
    const second = report("turn-2");
    void submit(owner, first);
    void submit(owner, second);
    for (const settled of [first, second]) {
      await owner.handleResult({
        type: "turn:report:result",
        requestId: settled.requestId,
        turnId: settled.turnId,
        resultHash: settled.resultHash,
        status: "conflict",
      });
    }
    expect(owner.awaitingServerCount).toBe(0);
    expect(owner.pendingCount).toBe(2);
    const third = submit(owner, report("turn-3"));
    await expect(Promise.race([third.then(() => "settled"), Promise.resolve("accepted")])).resolves.toBe("accepted");
    expect(owner.awaitingServerCount).toBe(1);
  });
});
