# BeFreed fork of OpenTag

This repository is `BeFreed-ai/opentag`, a fork of `first-tree-ai/opentag` (Apache-2.0). It is **not** an upstream
release and must not be presented as one (see `NOTICE`). Never open pull requests, issues or comments on the
upstream repository from our work; everything lands here first.

Baseline: upstream tag `v0.1.5` (`606a58b05541b0c4073b157374d05771f3d6fb4e`). The release line is the branch
`befreed/release-0.1.4` (the name is historical; its content is v0.1.5 plus the patches below). Do not build from
`main`: it is far behind upstream and is not a deployment baseline.

## Our patches against upstream v0.1.5

Every patch is small, default-off or diagnostics-only, and adds no database migration.

| # | Area | Files | Why | Default |
|---|------|-------|-----|---------|
| C1 | Client | `packages/client/src/runtime/session-message-inbox.ts`, `agent-turn-runner.ts`, new `provider-launch-configuration.ts` (+ tests) | A scheduled (session-message) turn gets the MCP gateway and web tools the Server granted | on |
| C2 | Client | `packages/client/src/runtime/context-tree-command-diagnostics.ts`, `context-tree-commands.ts` (+ tests) | Log Context Tree gateway failures (diagnostics only) | on |
| C3 | Client build | `scripts/befreed/set-fork-version.mjs`, `scripts/portable/build-portable.mjs` | Allow the `<stable>-befreed.<n>` version label | n/a |
| C4 | CI | `.github/workflows/befreed-client-release.yml`, `befreed-upstream-sync.yml` | Fork client release; weekly "upstream has something new" PR inside the fork | manual / weekly |
| S1 | Server build | `.github/workflows/befreed-server-image.yml` | Upstream's `docker.yml` only runs in the upstream repo; this builds the same Dockerfile (`runtime` target) and pushes to GHCR in our namespace | manual |
| S2 | Server | new `packages/server/src/services/schedules/operator-service.ts`, `packages/server/src/api/operator-schedules.ts`, `packages/server/src/operator-routes-config.ts`; wiring in `packages/server/src/app.ts` (+8 lines) and `packages/server/src/index.ts` (+9 lines) | Operator-only account route to create a schedule for an agent, with no inbound IM message (cron, one-time `at`, or "run in N seconds") | **off** |
| S3 | Server tests | `packages/server/src/__tests__/operator-schedule-api.test.ts`, `operator-routes-config.test.ts`, `__tests__/integration/operator-schedules.test.ts` | Tests for S2 | n/a |

S2 reuses upstream code for every rule: `ScheduleService.createForAgent` validates the cron grammar, timezone,
future occurrence, prompt size (16 KiB), and writes the row, the revision and the audit event;
`SessionService.ensureChatSession` finds or creates the target conversation and requires an active agent bound to a
computer. S2 only builds the "scope" that upstream normally derives from an agent's session proof, after the caller
passed authentication, the operator allow-list and the ownership check. It never reads or forges a session proof.

### What S2 does and does not do

- Route: `POST /api/v1/operator/agents/:agentId/schedules`. Registered only when `OPENTAG_OPERATOR_ROUTES_ENABLED=true`;
  otherwise the path does not exist (404, like any unknown path).
- Order of checks: Bearer token of the platform account (cookie sessions are refused) -> the user id must be in
  `OPENTAG_OPERATOR_USER_IDS` (else 403 `AGENT_FORBIDDEN`, before the body is read) -> strict body schema (400) -> the
  agent must belong to the calling account and not be deleted (else 404, same concealment as the account list/show
  routes) -> the agent needs an active IM binding (409 `SCHEDULE_TARGET_REQUIRED`) and an active agent bound to a
  computer (409 `SCHEDULE_TARGET_INVALID`).
- It still needs an existing IM binding (Slack or Feishu) for the agent: a session always hangs off one. It removes
  the need for a person to send the first message, not the need for a binding.
- Body: `channelId`, `conversationKind` (`channel|dm|group_dm`), `name`, `prompt`, either `schedule` (`cron` or `at`,
  or `every`) with `timezone`, or `runInSeconds` (5..3600, computed on the Server's database clock, one-time, cannot be
  combined with `enabled:false`), and optional `enabled` (default true; false creates it paused).
- It only creates. Listing, reading, pausing, resuming and deleting use the existing account routes
  (`GET/POST/DELETE /api/v1/agents/:agentId/schedules...`).
- Audit: one structured log line per call (`operator.schedule.created|denied|failed`) with the operator user id, agent
  id, schedule id and rule kind. Never the prompt, the token or any header. Upstream's own `schedule.created` event is
  logged as well. The log is not a durable audit trail; keep the Host-side audit chain for that.
- Known limits: a request that fails rule validation (for example a bad cron) can leave an empty channel session behind
  (harmless: the session is reused by the next call for the same channel). `enabled:false` is two steps (create, then
  pause), so a schedule due within milliseconds could in theory run once; do not combine it with an imminent `at`.
- The cookie-session refusal is a defensive second check; the unit tests cannot reach it because the test auth
  stub only produces Bearer sessions (see "Not verified" in the PR).

## Image build and publish (S1)

Registry: `ghcr.io/befreed-ai/opentag`. It uses only the workflow's default `GITHUB_TOKEN` (`packages: write`,
`contents: write`): no new secrets, no AWS, no IAM.

Tag format: `<upstream-version>-befreed.<n>`, for example `0.1.5-befreed.1`. The base must equal the source's upstream
version (`apps/cli/package.json`); `n` is never reused (the run refuses when the image tag or the git tag
`befreed-server-v<version>` exists). The git tag records the exact source SHA.

```bash
gh workflow run "BeFreed server image" --repo BeFreed-ai/opentag \
  -f version=0.1.5-befreed.1 -f ref=<our release branch or SHA>
gh run watch --repo BeFreed-ai/opentag
```

One-time, by an org owner (the workflow cannot do it): the first push creates the GHCR package as **private**. Either
make it public (GitHub -> Organization -> Packages -> `opentag` -> Package settings -> Change visibility) so the host
can pull anonymously like it does for the upstream image today, or create a read-only token with `read:packages`
and `docker login ghcr.io` on the host (that token is a new secret; do not put it in the repository).

Platform: `linux/amd64` only (the OpenTag host is x86_64). Provenance and SBOM attestations are off so the tag is a
plain single-platform manifest. Pin by digest when you want byte-for-byte certainty; the workflow summary prints it.

## Deploy runbook (EC2 + docker compose) and rollback

Prerequisites: not during the daily SEO round (a restart cuts a running agent turn, and the Server is a single
instance); a fresh EBS snapshot and a fresh `pg_dump` (same as the 0.1.5 upgrade); the image above exists and is
pullable from the host. S2 adds **no migration**, so the swap is symmetric and the rollback is a one-line revert. (A
future patch that adds a migration breaks that symmetry: upstream migrations are not rolled back with the image.)

On the host (as the user that owns `/opt/opentag`), placeholders in angle brackets:

```bash
cd /opt/opentag
cp .env ".env.bak.$(date +%Y%m%d-%H%M%S)"                 # keep it; it holds the OLD image line
grep '^OPENTAG_IMAGE=' .env                               # write down the current value = the rollback target
sed -i 's|^OPENTAG_IMAGE=.*|OPENTAG_IMAGE=ghcr.io/befreed-ai/opentag:<version>|' .env
docker compose pull opentag && docker compose up -d       # service name: use the one in docker-compose.yml
docker compose ps                                         # opentag healthy (the image has a /healthz healthcheck)
curl -fsS http://127.0.0.1:8000/healthz
```

Rollback (any time before the first schedule is created through the new route; and also after, since no schema
changed, the created schedules simply stay and keep firing):

```bash
cd /opt/opentag
sed -i 's|^OPENTAG_IMAGE=.*|OPENTAG_IMAGE=<the old value you wrote down, e.g. ghcr.io/first-tree-ai/opentag:606a58b0...>|' .env
docker compose pull opentag && docker compose up -d
```

Verify after a swap: `GET /healthz` is 200; the Web App loads; an existing schedule listing returns; the new route
is still absent (404) until you enable it.

## Enable the operator route, and call it

Do this only on a server whose image is a `-befreed` build that contains S2, and only after the swap above is healthy.

1. Find the platform account's user id (it is the account that owns the customer agents). With its token:
   `curl -fsS -H "Authorization: Bearer $TOKEN" "$SERVER/api/v1/me"` -> `user.id`.
2. In `/opt/opentag/.env` add (the compose file passes the whole `.env` through `env_file`):

   ```
   OPENTAG_OPERATOR_ROUTES_ENABLED=true
   OPENTAG_OPERATOR_USER_IDS=<platform-account-user-id>[,<second-id>]
   ```

   Enabled with an empty or malformed list stops the Server at startup instead of guessing. At most 16 ids.
3. `docker compose up -d` (restarts the container with the new env).
4. To switch it off again: set `OPENTAG_OPERATOR_ROUTES_ENABLED=false` (or delete both lines) and `docker compose up -d`.

Calls (placeholders only; `$TOKEN` is the platform account token and is never written to a file in the repository):

```bash
# Cron, with an explicit timezone
curl -fsS -X POST "$SERVER/api/v1/operator/agents/$AGENT_ID/schedules" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"channelId":"<slack-channel-or-dm-id>","conversationKind":"dm","name":"daily-seo",
       "prompt":"<task text>","schedule":{"kind":"cron","expression":"0 9 * * *"},"timezone":"America/Los_Angeles"}'

# One-time at an absolute instant
#   "schedule":{"kind":"at","at":"2026-11-09T17:00:00Z"},"timezone":"UTC"
# Run once in about 10 seconds (the scheduler scans every 5 s; a run later than 30 s after due is skipped)
#   {"channelId":"...","conversationKind":"dm","name":"run-now","prompt":"...","runInSeconds":10}
# Create paused:   add "enabled": false

# Read it back with the existing routes
curl -fsS -H "Authorization: Bearer $TOKEN" "$SERVER/api/v1/agents/$AGENT_ID/schedules"
```

Errors: `401` no/invalid token; `403 AGENT_FORBIDDEN` not on the allow-list; `404` unknown agent, another account's
agent, or the route is switched off; `400` invalid body or rule (`SCHEDULE_INVALID_RULE`,
`SCHEDULE_INVALID_TIMEZONE`); `409` no IM binding / agent not active or not bound to a computer / no future occurrence.

Risk to keep in mind: the platform token has no scope. With this route on, whoever holds it can give any of that
account's agents a prompt and trigger a turn. Keep the token in Secrets Manager, keep the allow-list to the platform
account only, and switch the route off when it is not in use.

## Known limits of the operator schedule route

Found in the independent security review of the S2 route (no P1/P2 blockers; these are accepted, documented limits):

1. **No idempotency or duplicate protection.** Two identical create calls create two schedules. Usage rule: the
   stage-relay script must **list the agent's schedules before creating** (idempotency is the caller's job), and must
   not blindly retry a create whose response was lost.
2. **Create-then-pause is not one transaction.** Creating with `enabled: false` is done as create, then pause. If the
   pause step fails, a live schedule can remain. After any error on a paused create, list schedules and pause or delete
   the stray one.
3. **Binding selection is non-deterministic** when an agent has both a Slack and a Feishu binding: the route picks one of
   them without a stable rule. Keep one IM binding per agent that uses this route.
4. **No rate limit** on the route. The only brake is the per-token allow-list and the operator keeping the route off when
   unused.
5. **`channelId` is not validated** against the agent's binding or the IM platform. A wrong ID fails later at delivery
   time, not at create time.

## Rebasing onto a newer upstream

Policy: stay on v0.1.5 plus our patches; move the baseline only for a needed fix, through an upgrade rehearsal.

1. `git fetch upstream && git checkout -b befreed/release-<new> befreed/release-0.1.4`
2. `git merge <upstream tag>`; our files to expect conflicts in: `packages/server/src/app.ts` and `index.ts` (the
   wiring is a few lines), and `packages/server/src/services/schedules/service.ts` is **not** modified by us, but
   `operator-service.ts` imports `AgentScheduleScope`, `ScheduleClock`, `scheduleDatabaseClock` from it and calls
   `createForAgent` / `pauseForAgent`: if upstream changes those signatures (it rewrote the create-target logic in
   `522ef31d`, after v0.1.5) adapt `operator-service.ts`, not upstream.
3. Re-run: `pnpm --filter @opentag/server exec vitest run src/__tests__/operator-schedule-api.test.ts src/__tests__/operator-routes-config.test.ts`
   and the integration test `src/__tests__/integration/operator-schedules.test.ts` (needs Docker).
4. If upstream ships a real account-level create route, delete S2 and use theirs.
