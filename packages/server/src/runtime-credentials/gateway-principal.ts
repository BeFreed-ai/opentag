/*
 * BeFreed modification (Apache-2.0 section 4(b)): this file is new in the BeFreed fork. It is not part of
 * upstream OpenTag. See BEFREED.md (patch S4).
 *
 * The signed principal of a gateway tool call.
 *
 * When an MCP server is marked as requiring it, the MCP gateway tells that server *who* triggered the
 * execution that is calling it: the person whose IM message started the turn, the schedule that started
 * it, the agent that messaged it, or the system. The statement is derived from the execution record and
 * existing tables only (nothing the model or the request body says is ever read as an identity), and is
 * authenticated with an HMAC over the exact request body, so the upstream can verify it without trusting
 * the network.
 *
 * Wire format (frozen contract v1, signer side):
 *
 *   X-Opentag-Principal            base64url(UTF-8 JSON), no padding
 *   X-Opentag-Principal-Key        <keyId>
 *   X-Opentag-Principal-Timestamp  <unix seconds>
 *   X-Opentag-Principal-Signature  v1=<lowercase hex HMAC-SHA256(secret[keyId], signingString)>
 *
 *   signingString = keyId "." timestamp "." principalB64 "." lowercase_hex(SHA-256(exact request body bytes))
 *
 * Keys come from one environment variable (`OPENTAG_GATEWAY_PRINCIPAL_KEYS`, a JSON map keyId -> secret)
 * plus the id of the key to sign with (`OPENTAG_GATEWAY_PRINCIPAL_KEY_ID`). The secret is used as its
 * UTF-8 bytes, exactly as written. Nothing here ever logs a secret, a header or a principal identifier.
 */

import { createHmac, randomUUID } from "node:crypto";
import { and, eq, inArray, or } from "drizzle-orm";
import type { DatabaseClient } from "../db/client.js";
import { imBindings, imMessageDeliveries, imMessages, sessionMessages } from "../db/schema/index.js";
import { MCP_ERROR_CODES, McpServiceError } from "../services/mcp/errors.js";
import type { RuntimeExecutionRecord } from "./types.js";

export const GATEWAY_PRINCIPAL_KEYS_ENV = "OPENTAG_GATEWAY_PRINCIPAL_KEYS";
export const GATEWAY_PRINCIPAL_KEY_ID_ENV = "OPENTAG_GATEWAY_PRINCIPAL_KEY_ID";

/** Fixed code of the gateway failure for a marked server whose principal cannot be signed. */
export const GATEWAY_PRINCIPAL_UNAVAILABLE = "principal_unavailable";
const GATEWAY_PRINCIPAL_UNAVAILABLE_MESSAGE =
  "This MCP Server requires a signed caller identity that the gateway cannot provide right now";

/** The failure of a marked server's call when it cannot be signed. Never carries a cause or a value. */
export class GatewayPrincipalUnavailableError extends McpServiceError {
  readonly gatewayCode = GATEWAY_PRINCIPAL_UNAVAILABLE;

  constructor() {
    super(MCP_ERROR_CODES.UPSTREAM_UNAVAILABLE, GATEWAY_PRINCIPAL_UNAVAILABLE_MESSAGE);
    this.name = "GatewayPrincipalUnavailableError";
  }
}

export class GatewayPrincipalConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayPrincipalConfigError";
  }
}

export type GatewayPrincipalKind = "human" | "scheduled" | "agent" | "system" | "unknown";
export type GatewayPrincipalProvider = "slack" | "feishu";

export interface GatewayPrincipalIdentity {
  provider: GatewayPrincipalProvider | null;
  team: string | null;
  user: string | null;
}

/** The contract's `principal` object. Every key is always present; unknown is `null`. */
export interface GatewayPrincipal {
  kind: GatewayPrincipalKind;
  provider: GatewayPrincipalProvider | null;
  team: string | null;
  user: string | null;
  channel: string | null;
  shared_channel: boolean | null;
  attention: "direct" | "ambient" | null;
  schedule_id: string | null;
  via_session: string | null;
  creator: GatewayPrincipalIdentity | null;
}

function emptyPrincipal(kind: GatewayPrincipalKind): GatewayPrincipal {
  return {
    kind,
    provider: null,
    team: null,
    user: null,
    channel: null,
    shared_channel: null,
    attention: null,
    schedule_id: null,
    via_session: null,
    creator: null,
  };
}

const UNKNOWN_PRINCIPAL = emptyPrincipal("unknown");

function knownProvider(value: string): GatewayPrincipalProvider | undefined {
  return value === "slack" || value === "feishu" ? value : undefined;
}

interface DeliveryAuthor {
  provider: GatewayPrincipalProvider;
  team: string | null;
  user: string;
}

/**
 * The human who authored the one IM message a delivery belongs to, or `undefined` when there is no such
 * row, the author is not a human (bot, system), or the provider is not one the contract names.
 * `sessionId` pins the delivery to the Session the caller says it belongs to.
 *
 * Used only for a schedule's `creator`, which is one recorded message (the source delivery's own author),
 * not a turn: the turn rule below does not apply to it.
 */
async function loadDeliveryAuthor(
  database: DatabaseClient,
  deliveryId: string,
  sessionId: string,
): Promise<DeliveryAuthor | undefined> {
  const [row] = await database
    .select({
      authorKind: imMessages.authorKind,
      authorExternalId: imMessages.authorExternalId,
      provider: imBindings.provider,
      teamId: imBindings.externalTeamId,
    })
    .from(imMessageDeliveries)
    .innerJoin(imMessages, eq(imMessages.id, imMessageDeliveries.messageId))
    .innerJoin(imBindings, eq(imBindings.id, imMessages.imBindingId))
    .where(and(eq(imMessageDeliveries.id, deliveryId), eq(imMessageDeliveries.sessionId, sessionId)))
    .limit(1);
  if (row?.authorKind !== "human" || !row.authorExternalId) return undefined;
  const provider = knownProvider(row.provider);
  if (!provider) return undefined;
  return { provider, team: row.teamId ?? null, user: row.authorExternalId };
}

const TURN_COLUMNS = {
  id: imMessageDeliveries.id,
  attention: imMessageDeliveries.attention,
  authorKind: imMessages.authorKind,
  authorExternalId: imMessages.authorExternalId,
  channelId: imMessages.channelId,
  providerContext: imMessages.providerContext,
  bindingId: imBindings.id,
  provider: imBindings.provider,
  teamId: imBindings.externalTeamId,
};

/**
 * Every delivery that drives the turn of `rootDeliveryId`, as of now: the root itself plus each delivery in
 * the same Session whose steer target is the root (batch members and later steers). A batch member is
 * stamped with its target before the model can act on it, and while a batch is still being settled it
 * points at the steer delivery that in turn points at the root, so that second hop is followed too.
 * (A second accepted delivery with the same `turnId` cannot exist: `turn_id` is unique.)
 */
async function loadTurn(database: DatabaseClient, rootDeliveryId: string, sessionId: string) {
  const inSession = eq(imMessageDeliveries.sessionId, sessionId);
  const direct = await database
    .select({ id: imMessageDeliveries.id })
    .from(imMessageDeliveries)
    .where(and(inSession, eq(imMessageDeliveries.steerTargetDeliveryId, rootDeliveryId)));
  const firstHop = direct.map((row) => row.id);
  const ids = [rootDeliveryId, ...firstHop];
  return database
    .select(TURN_COLUMNS)
    .from(imMessageDeliveries)
    .innerJoin(imMessages, eq(imMessages.id, imMessageDeliveries.messageId))
    .innerJoin(imBindings, eq(imBindings.id, imMessages.imBindingId))
    .where(
      and(
        inSession,
        or(
          inArray(imMessageDeliveries.id, ids),
          firstHop.length > 0 ? inArray(imMessageDeliveries.steerTargetDeliveryId, firstHop) : undefined,
        ),
      ),
    );
}

function sharedChannelOf(context: { provider?: string; isExtSharedChannel?: boolean } | null): boolean | null {
  return context?.provider === "slack" && typeof context.isExtSharedChannel === "boolean"
    ? context.isExtSharedChannel
    : null;
}

/** `true` if any message says true; else `null` if any says nothing; else `false`. */
function aggregateSharedChannel(values: readonly (boolean | null)[]): boolean | null {
  if (values.some((value) => value === true)) return true;
  return values.some((value) => value === null) ? null : false;
}

/**
 * The principal of a delivery-sourced execution, over the whole turn. `human` only when every message of
 * the turn is by a human, all the same author id on the same binding; any second author, bot or system
 * author, or missing root row is `unknown` (user and team null).
 */
async function deriveTurnPrincipal(
  database: DatabaseClient,
  rootDeliveryId: string,
  sessionId: string,
): Promise<GatewayPrincipal> {
  const rows = await loadTurn(database, rootDeliveryId, sessionId);
  const root = rows.find((row) => row.id === rootDeliveryId);
  if (!root) return UNKNOWN_PRINCIPAL;
  const common = {
    channel: root.channelId,
    shared_channel: aggregateSharedChannel(rows.map((row) => sharedChannelOf(row.providerContext))),
    attention: rows.some((row) => row.attention === "ambient") ? ("ambient" as const) : ("direct" as const),
  };
  const provider = knownProvider(root.provider);
  const oneHuman =
    provider !== undefined &&
    rows.every(
      (row) =>
        row.authorKind === "human" &&
        row.authorExternalId === root.authorExternalId &&
        row.bindingId === root.bindingId,
    );
  if (!oneHuman || !provider) return { ...emptyPrincipal("unknown"), ...common };
  return {
    ...emptyPrincipal("human"),
    ...common,
    provider,
    team: root.teamId ?? null,
    user: root.authorExternalId,
  };
}

async function derive(
  database: DatabaseClient,
  execution: Pick<RuntimeExecutionRecord, "source" | "sessionId">,
): Promise<GatewayPrincipal> {
  const { source, sessionId } = execution;
  if (source.kind === "validation") return emptyPrincipal("system");
  if (source.kind === "delivery") return deriveTurnPrincipal(database, source.deliveryId, sessionId);
  if (source.kind === "session-message") {
    const [message] = await database
      .select({
        sourceSessionId: sessionMessages.sourceSessionId,
        scheduledOrigin: sessionMessages.scheduledOrigin,
        userTaskSource: sessionMessages.userTaskSource,
      })
      .from(sessionMessages)
      .where(and(eq(sessionMessages.id, source.messageId), eq(sessionMessages.targetSessionId, sessionId)))
      .limit(1);
    if (!message) return UNKNOWN_PRINCIPAL;
    if (message.scheduledOrigin) {
      return {
        ...emptyPrincipal("scheduled"),
        schedule_id: message.scheduledOrigin.scheduleId,
        creator: await deriveCreator(database, message.userTaskSource),
      };
    }
    if (message.sourceSessionId) {
      return { ...emptyPrincipal("agent"), via_session: message.sourceSessionId };
    }
  }
  return UNKNOWN_PRINCIPAL;
}

/** Who a schedule runs on behalf of: the human behind the recorded delivery source, else `null`. */
async function deriveCreator(
  database: DatabaseClient,
  taskSource: { sessionId: string; source: { kind: string; deliveryId?: string } } | null,
): Promise<GatewayPrincipalIdentity | null> {
  if (taskSource?.source.kind !== "delivery" || !taskSource.source.deliveryId) return null;
  try {
    const author = await loadDeliveryAuthor(database, taskSource.source.deliveryId, taskSource.sessionId);
    return author ? { provider: author.provider, team: author.team, user: author.user } : null;
  } catch {
    return null;
  }
}

/**
 * Map an execution to the principal the contract defines, from existing rows only.
 *
 * Never throws and never guesses: a missing row, a bot author, an unexpected source or any failed
 * lookup yields kind `unknown`, and the verifier on the other side decides what that is worth.
 */
export async function derivePrincipal(
  database: DatabaseClient,
  execution: Pick<RuntimeExecutionRecord, "source" | "sessionId">,
): Promise<GatewayPrincipal> {
  try {
    return await derive(database, execution);
  } catch {
    return UNKNOWN_PRINCIPAL;
  }
}

/** What the signed statement names besides the principal itself. */
export interface GatewayPrincipalCallContext {
  account: string;
  agent: string;
  execution: string;
  tool: string;
  principal: GatewayPrincipal;
}

export interface SignedGatewayPrincipal {
  /** The four request headers, in their canonical spelling. */
  headers: Record<string, string>;
  /** The `call` id inside the signed statement. */
  call: string;
}

export class GatewayPrincipalSigner {
  readonly #keys: ReadonlyMap<string, string>;
  readonly #activeKeyId: string;
  readonly #now: () => number;

  constructor(keys: ReadonlyMap<string, string>, activeKeyId: string, now: () => number = Date.now) {
    if (!keys.has(activeKeyId)) throw new GatewayPrincipalConfigError("The signing key id is not in the key map");
    this.#keys = keys;
    this.#activeKeyId = activeKeyId;
    this.#now = now;
  }

  /**
   * Sign one request. `bodySha256` is the lowercase hex SHA-256 of the exact bytes about to be sent;
   * `call` is a fresh UUID v4 per signed request, so a re-send of the same logical call is a new
   * statement and cannot collide with the verifier's replay window.
   */
  sign(context: GatewayPrincipalCallContext, bodySha256: string): SignedGatewayPrincipal {
    const secret = this.#keys.get(this.#activeKeyId);
    if (secret === undefined) throw new GatewayPrincipalUnavailableError();
    const iat = Math.floor(this.#now() / 1000);
    const call = randomUUID();
    const statement = {
      v: 1,
      gateway: "opentag",
      account: context.account,
      agent: context.agent,
      execution: context.execution,
      call,
      tool: context.tool,
      iat,
      principal: context.principal,
    };
    const principalB64 = Buffer.from(JSON.stringify(statement), "utf8").toString("base64url");
    const timestamp = String(iat);
    const signingString = `${this.#activeKeyId}.${timestamp}.${principalB64}.${bodySha256}`;
    const signature = createHmac("sha256", secret).update(signingString, "utf8").digest("hex");
    return {
      call,
      headers: {
        "X-Opentag-Principal": principalB64,
        "X-Opentag-Principal-Key": this.#activeKeyId,
        "X-Opentag-Principal-Timestamp": timestamp,
        "X-Opentag-Principal-Signature": `v1=${signature}`,
      },
    };
  }
}

const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MIN_SECRET_BYTES = 32;

/**
 * Read the signing keys once at startup. Neither variable set means "no key": the gateway still starts,
 * and a call to a marked server fails closed. Anything half-set or malformed stops the Server at startup.
 * Values never appear in an error message.
 */
export function parseGatewayPrincipalConfig(environment: NodeJS.ProcessEnv): GatewayPrincipalSigner | undefined {
  const rawKeys = (environment[GATEWAY_PRINCIPAL_KEYS_ENV] ?? "").trim();
  const keyId = (environment[GATEWAY_PRINCIPAL_KEY_ID_ENV] ?? "").trim();
  if (rawKeys === "" && keyId === "") return undefined;
  if (rawKeys === "") {
    throw new GatewayPrincipalConfigError(`${GATEWAY_PRINCIPAL_KEY_ID_ENV} needs ${GATEWAY_PRINCIPAL_KEYS_ENV}`);
  }
  if (keyId === "") {
    throw new GatewayPrincipalConfigError(`${GATEWAY_PRINCIPAL_KEYS_ENV} needs ${GATEWAY_PRINCIPAL_KEY_ID_ENV}`);
  }
  const keys = parseKeyMap(rawKeys);
  if (!keys.has(keyId)) {
    throw new GatewayPrincipalConfigError(
      `${GATEWAY_PRINCIPAL_KEY_ID_ENV} is not a key id in ${GATEWAY_PRINCIPAL_KEYS_ENV}`,
    );
  }
  return new GatewayPrincipalSigner(keys, keyId);
}

function parseKeyMap(raw: string): Map<string, string> {
  const shape = `${GATEWAY_PRINCIPAL_KEYS_ENV} must be a JSON object of key id to secret`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new GatewayPrincipalConfigError(shape);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new GatewayPrincipalConfigError(shape);
  }
  const keys = new Map<string, string>();
  for (const [id, secret] of Object.entries(parsed)) {
    if (!KEY_ID_PATTERN.test(id)) {
      throw new GatewayPrincipalConfigError(
        `${GATEWAY_PRINCIPAL_KEYS_ENV} has a key id that is not 1-64 of A-Z a-z 0-9 _ -`,
      );
    }
    if (typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < MIN_SECRET_BYTES) {
      throw new GatewayPrincipalConfigError(
        `${GATEWAY_PRINCIPAL_KEYS_ENV} has a secret shorter than ${MIN_SECRET_BYTES} bytes`,
      );
    }
    keys.set(id, secret);
  }
  if (keys.size === 0) {
    throw new GatewayPrincipalConfigError(`${GATEWAY_PRINCIPAL_KEYS_ENV} must name at least one key`);
  }
  return keys;
}

/**
 * What the gateway service needs to authenticate a call as a principal: the optional signer (absent when no
 * key is configured, which makes every marked call fail closed) and the derivation.
 */
export interface GatewayPrincipalSource {
  signer: GatewayPrincipalSigner | undefined;
  derive(execution: RuntimeExecutionRecord): Promise<GatewayPrincipal>;
}

export function createGatewayPrincipalSource(
  database: DatabaseClient,
  signer: GatewayPrincipalSigner | undefined,
): GatewayPrincipalSource {
  return { signer, derive: (execution) => derivePrincipal(database, execution) };
}
