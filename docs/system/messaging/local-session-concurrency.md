---
title: "Local Agent session concurrency"
description: "Capability-gated three-way Local Agent delivery concurrency with session ordering and custody safeguards."
soft_links:
  - /system/messaging/im-delivery-claim.md
  - /system/server-client-boundary.md
  - /system/agent-session-computer-model.md
---

# Local Agent session concurrency

## Intent

Local Agents can accept work from different Sessions concurrently without
allowing two deliveries in the same Session to overlap. The default remains
one active Local delivery per Agent. A Local Computer becomes eligible for a
higher limit only after it negotiates the `runtime.localSessionConcurrency`
capability.

## Admission contract

For a Local delivery on a Computer that negotiated the capability:

- the same Session has at most one active delivery;
- the Local Agent has at most the configured active-delivery limit, initially
  three; and
- Local and Cloud delivery for the same Agent remain mutually exclusive.

Computers without the capability keep the existing Agent-wide one-delivery
rule. The fourth Local Session waits for a later claim scan; it is neither
steered into another Session nor lost. Cloud delivery continues to treat any
active Local delivery as conflicting.

## Authority and consistency

`im_message_deliveries` remains the sole durable custody authority. No table,
column, state, migration, or retention rule is added. Candidate scans may use
an in-memory custody snapshot only as a hint. The final admission check runs
inside the existing Agent advisory-lock transaction, re-reads active custody,
and persists the claim only when the Session and Agent limits still hold.

The worker uses a Session scheduler lane for a capability-enabled Local
Computer and retains the existing Agent lane for legacy Local Computers. The
final connection-fenced send repeats the same custody decision so a stale
candidate cannot create a fourth active Local delivery. It is bound to the
specific v2 connection that negotiated the capability: a reconnect or
capability loss during reconciliation retries instead of sending parallel work
to the replacement connection.

## Client prerequisites and rollout

The Client advertises `runtime.localSessionConcurrency` in its registration
capabilities and must reconnect before the Server can use it. A capability
absent from the negotiated result is an explicit one-delivery fallback.

Concurrent code tasks use their own Git worktree. Each task places non-code
output under its own task-named subdirectory. Claude native histories are
already per native Session; shared `memory/` writes are serialized by the
Client's memory-write hook. The Server deploys with the Local limit at one;
an operator raises only a validated Local Computer to three after the Client
has installed its hook, reconnected, and confirmed capability negotiation.

## Failure behavior

Accepted custody keeps its current report, timeout, disconnect, retry, and
retention behavior. A missing report does not free a concurrency slot. An
actual terminal report or existing recovery path releases custody as it does
for serial Local execution. Reducing the configured limit to one stops new
parallel admissions and does not interrupt deliveries already running.
