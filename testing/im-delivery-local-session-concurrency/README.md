# Local Agent session concurrency implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permit up to three concurrent Local deliveries for different Sessions only when the Local Client negotiated the dedicated capability, while preserving existing custody and Local/Cloud exclusion.

**Architecture:** The shared runtime protocol adds an optional version-one capability. The delivery custody snapshot receives an explicit admission policy so legacy Local and all Cloud behavior stays unchanged. The worker derives the policy from the live negotiated capability and a per-computer limit, then supplies it to selection, the Agent-advisory-lock transaction, the scheduler lane, and the last pre-send custody check.

**Tech Stack:** TypeScript, Zod runtime protocol, Drizzle/PostgreSQL custody queries, Vitest with PGlite unit tests.

**Spec:** `docs/system/messaging/local-session-concurrency.md`

## Global Constraints

- No schema, migration, retention, report, timeout, or retry behavior changes.
- The existing Agent advisory lock remains the final admission boundary.
- Legacy or capability-absent Local Clients remain at one active delivery.
- Local and Cloud delivery for one Agent remain mutually exclusive.
- Unit tests use synthetic data and no external runtime or messaging provider.

## Review Focus

- A legacy Local Client must stay Agent-wide serial even if its configured limit is three.
- A capability-enabled Local Client must refuse the fourth different-Session custody owner.
- A same-Session delivery must remain blocked even below the Agent concurrency limit.
- An active Cloud delivery must block capability-enabled Local admission, and any Local occupancy must block Cloud admission.
- A stale selection must be rejected by the final transaction and by the pre-send custody recheck.

### Task 1: Runtime capability contract

**Files:**
- Modify: `packages/shared/src/runtime-protocol.ts`
- Modify: `packages/shared/src/__tests__/runtime-protocol.test.ts`

**Interfaces:**
- Produces: `RUNTIME_CAPABILITY.localSessionConcurrency` and an optional negotiated capability at version `1`.
- Consumed by: `ImDeliveryWorker` capability lookup in Task 3.

- [x] **Step 1: Write the failing protocol test**

Add a test that expects both server and client capability-offer maps to expose `runtime.localSessionConcurrency` with `{ min: 1, max: 1 }`, and that negotiation with a version-one peer returns version `1`.

- [x] **Step 2: Run the protocol test to verify it fails**

Run: `pnpm --filter @opentag/shared exec vitest run src/__tests__/runtime-protocol.test.ts --maxWorkers=1`

Expected: FAIL because `localSessionConcurrency` is absent.

- [x] **Step 3: Add the optional capability to `runtime-protocol.ts`**

Add `localSessionConcurrency: "runtime.localSessionConcurrency"` to `RUNTIME_CAPABILITY` and its version-one offer to `RUNTIME_SERVER_CAPABILITY_OFFERS`. Do not add it to either required-capabilities array.

- [x] **Step 4: Run the protocol test to verify it passes**

Run: `pnpm --filter @opentag/shared exec vitest run src/__tests__/runtime-protocol.test.ts --maxWorkers=1`

Expected: PASS.

### Task 2: Explicit custody admission policy

**Files:**
- Modify: `packages/server/src/runtime/im-delivery-work-query.ts`
- Modify: `packages/server/src/runtime/im-delivery-custody.ts`
- Modify: `packages/server/src/__tests__/im-delivery-custody.test.ts`

**Interfaces:**
- Consumes: optional Local policy `{ localSessionConcurrency: boolean; localAgentMaxConcurrent: number }`.
- Produces: policy-aware `DeliveryCustodySnapshot.other`, `findOtherCustody`, `hasOtherCustody`, and `deliveryOccupancyScope`.
- Consumed by: selector and worker integration in Task 3.

- [x] **Step 1: Write failing custody tests**

Add synthetic fixtures proving: a capability-enabled Local Agent admits three different Sessions; the fourth is fenced; the same Session remains fenced; legacy Local remains Agent-wide serial; and Cloud/Local mutual exclusion still applies.

- [x] **Step 2: Run the custody test to verify it fails**

Run: `pnpm --filter @opentag/server exec vitest run src/__tests__/im-delivery-custody.test.ts --maxWorkers=1`

Expected: FAIL because the current snapshot treats every Local custody row as an immediate Agent-wide conflict.

- [x] **Step 3: Implement the minimal policy-aware custody queries**

Track Local and Cloud custody separately inside `DeliveryCustodySnapshot`. For a capability-enabled Local subject, reject same-Session custody, any Cloud custody, or a Local count at the configured bound; otherwise retain the prior result. Keep Cloud subjects fenced by any Local custody. Use a session scope only for a capability-enabled Local scheduler lane.

- [x] **Step 4: Run the custody test to verify it passes**

Run: `pnpm --filter @opentag/server exec vitest run src/__tests__/im-delivery-custody.test.ts --maxWorkers=1`

Expected: PASS.

### Task 3: Capability-gated worker admission and final recheck

**Files:**
- Modify: `packages/server/src/runtime/im-delivery-selector.ts`
- Modify: `packages/server/src/runtime/im-delivery-worker.ts`
- Modify: `packages/server/src/runtime/im-delivery-worker.types.d.ts`
- Modify: `packages/server/src/index.ts`
- Modify: `packages/server/src/config.ts`
- Modify: `packages/server/src/__tests__/im-delivery-selector.test.ts`
- Modify: `packages/server/src/__tests__/im-delivery-worker.test.ts`
- Modify: `docs/system/messaging/im-delivery-claim.md`
- Modify: `testing/im-delivery-local-session-concurrency/README.md`

**Interfaces:**
- Consumes: Task 1 capability and Task 2 custody policy.
- Produces: per-computer limit resolution with a default of one and a live capability-gated Local policy used for selection, transactional claim, scheduler lane, and pre-send custody recheck.

- [x] **Step 1: Write failing selector and worker tests**

Add tests that a negotiated Local Computer at limit three selects and claims three different Sessions, defers the fourth, uses different scheduler lanes for those Sessions, and falls back to one when negotiation is absent or the live instance changes.

- [x] **Step 2: Run the focused server tests to verify they fail**

Run: `pnpm --filter @opentag/server exec vitest run src/__tests__/im-delivery-selector.test.ts src/__tests__/im-delivery-worker.test.ts --maxWorkers=1`

Expected: FAIL because selector, transaction claim, and pre-send admission do not receive a negotiated Local policy.

- [x] **Step 3: Thread the live policy through every admission boundary**

Resolve a Local policy only when `ConnectionRegistry.currentInstanceId` matches the delivery's current instance and supports `RUNTIME_CAPABILITY.localSessionConcurrency`. Default all computer limits to one; parse an explicitly configured per-computer limit only for rollout. Pass the policy to selector eligibility, `lockEligibleDelivery`, scheduler lane resolution, and `hasOtherCustody` before Local delivery frames. Preserve existing Cloud calls without a Local policy.

- [x] **Step 4: Update durable behavior and verification documentation**

Describe capability-gated Local custody and the focused acceptance commands in the existing delivery-claim page and this test plan. Do not record production deployment results in repository documentation.

- [x] **Step 5: Run focused checks to verify they pass**

Run: `pnpm --filter @opentag/server exec vitest run src/__tests__/im-delivery-selector.test.ts src/__tests__/im-delivery-worker.test.ts src/__tests__/im-delivery-custody.test.ts --maxWorkers=1`

Expected: PASS.

- [ ] **Step 6: Run affected package validation**

Run: `pnpm --filter @opentag/shared build && pnpm --filter @opentag/server typecheck && pnpm --filter @opentag/server build && pnpm check`

Expected: PASS.

## Self-review

- Spec coverage: Tasks 1–3 cover optional negotiation, legacy fallback, three-way Local admission, same-Session ordering, Local/Cloud exclusion, advisory-lock authority, final recheck, and documented rollout.
- Type consistency: Task 1 exports the capability key; Task 2 owns the reusable policy and Task 3 supplies it from the live registry.
- Review focus: Task 2 covers serial fallback, three-way limit, same-session fencing, and Cloud/Local exclusion; Task 3 covers stale/lost negotiation at every worker boundary.
- Proportion: The plan specifies file boundaries, tests, and admission decisions without prescribing implementation bodies.
