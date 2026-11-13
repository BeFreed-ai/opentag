import { createHash } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { DatabaseTransaction } from "../../db/client.js";
import { agentMcpServers, mcpServerAuthorizations, mcpServers } from "../../db/schema/index.js";
import {
  type McpAuthorizationContext,
  type McpExecutor,
  mcpEffectiveConfig,
  readMcpAuthorizationContexts,
} from "./mcp-authorization-graph.js";

export const GITHUB_MCP_ISSUER = "https://github.com/login/oauth";
const ENDPOINTS = ["https://api.githubcopilot.com/mcp/", "https://api.githubcopilot.com/mcp"];
/** The only URL an external Bearer connector may point at: the single-tenant minimum gate. */
const EXTERNAL_BEARER_ENDPOINT = "https://api.githubcopilot.com/mcp/";

/**
 * Opt-in for the one connector whose Bearer key an external rotator keeps current. It is matched on
 * the exact name and the exact GitHub MCP URL. A name is unique only within an Account, so anyone who
 * can create connectors in the Account could squat it first; that is acceptable while the Account
 * holds only trusted operators and must be hardened before the Account is shared with others.
 */
export interface GitHubExternalBearerOptions {
  enabled: boolean;
  serverName: string;
}

export interface GitHubMcpAuthorityFence {
  accountId: string;
  agentId: string;
  mcpServerId: string;
  localAuthorizationId: string;
  rootAuthorizationId: string;
  authorizationVersion: string;
  /** Present only for an external-Bearer fence: the connector name it was admitted under. */
  externalBearerServerName?: string;
}

function isExternalBearer(context: McpAuthorizationContext, external: GitHubExternalBearerOptions | undefined) {
  return (
    external?.enabled === true &&
    context.binding.enabled &&
    context.authorization?.kind === "bearer" &&
    context.authorization.status === "active" &&
    context.server.name === external.serverName &&
    mcpEffectiveConfig(context.server, context.binding).url === EXTERNAL_BEARER_ENDPOINT
  );
}

/** True when this mount is accepted as the external Bearer connector under the given options. */
export function gitHubMcpExternalBearer(
  context: McpAuthorizationContext,
  external: GitHubExternalBearerOptions | undefined,
): boolean {
  return isExternalBearer(context, external);
}

export async function readAgentGitHubMcp(
  executor: McpExecutor,
  accountId: string,
  agentId: string,
  external?: GitHubExternalBearerOptions,
) {
  if (external?.enabled) {
    // The rotated connector wins over an older OAuth mount, but only while it holds an active Bearer key.
    const [preferred] = await readMcpAuthorizationContexts(
      executor,
      and(
        eq(mcpServers.accountId, accountId),
        eq(agentMcpServers.agentId, agentId),
        eq(mcpServers.name, external.serverName),
        eq(mcpServerAuthorizations.kind, "bearer"),
        eq(mcpServerAuthorizations.status, "active"),
        eq(sql<string>`coalesce(${agentMcpServers.urlOverride}, ${mcpServers.url})`, EXTERNAL_BEARER_ENDPOINT),
      ),
      { tools: false, oldestMount: true, limit: 1 },
    );
    if (preferred && isExternalBearer(preferred, external)) return preferred;
  }
  const [context] = await readMcpAuthorizationContexts(
    executor,
    and(
      eq(mcpServers.accountId, accountId),
      eq(agentMcpServers.agentId, agentId),
      inArray(sql<string>`coalesce(${agentMcpServers.urlOverride}, ${mcpServers.url})`, ENDPOINTS),
    ),
    { tools: false, oldestMount: true, limit: 1 },
  );
  return context;
}

export function gitHubMcpFence(
  context: McpAuthorizationContext,
  external?: GitHubExternalBearerOptions,
): GitHubMcpAuthorityFence | undefined {
  const { authorization, localAuthorization: local, credentialAuthorization: root, binding, server, agent } = context;
  if (authorization?.kind === "bearer") return externalBearerFence(context, external);
  if (
    !binding.enabled ||
    authorization?.kind !== "oauth" ||
    authorization.status !== "active" ||
    !local ||
    !root ||
    root.authorizationServer !== GITHUB_MCP_ISSUER
  )
    return undefined;
  const effective = mcpEffectiveConfig(server, binding);
  const version = createHash("sha256")
    .update(
      JSON.stringify([
        server.accountId,
        agent.id,
        server.id,
        local.id,
        local.revision,
        root.id,
        root.revision,
        root.authorizationServer,
        root.oauthResource,
        root.clientRegistrationId,
        [...(root.scopes ?? [])].sort(),
        effective.url,
        effective.authHeader,
        effective.authScheme,
        Object.entries(effective.extraHeaders).sort(([a], [b]) => a.localeCompare(b)),
      ]),
    )
    .digest("hex");
  return {
    accountId: server.accountId,
    agentId: agent.id,
    mcpServerId: server.id,
    localAuthorizationId: local.id,
    rootAuthorizationId: root.id,
    authorizationVersion: `mcp:${version}`,
  };
}

/**
 * The version deliberately omits `revision`. The rotator rewrites the Bearer key every few minutes and
 * each write bumps the row's revision, so a revision in the version would make every in-flight
 * Context Tree operation fail its authorization-version check. The key is read fresh from the row on
 * each use; what must stay stable is the identity (row, connector, endpoint, headers).
 */
function externalBearerFence(
  context: McpAuthorizationContext,
  external: GitHubExternalBearerOptions | undefined,
): GitHubMcpAuthorityFence | undefined {
  const { authorization, server, agent, binding } = context;
  if (!external || !authorization || !isExternalBearer(context, external)) return undefined;
  const effective = mcpEffectiveConfig(server, binding);
  const version = createHash("sha256")
    .update(
      JSON.stringify([
        "external-bearer",
        server.accountId,
        agent.id,
        server.id,
        server.name,
        authorization.id,
        effective.url,
        effective.authHeader,
        effective.authScheme,
        Object.entries(effective.extraHeaders).sort(([a], [b]) => a.localeCompare(b)),
      ]),
    )
    .digest("hex");
  return {
    accountId: server.accountId,
    agentId: agent.id,
    mcpServerId: server.id,
    localAuthorizationId: authorization.id,
    rootAuthorizationId: authorization.id,
    authorizationVersion: `mcp:${version}`,
    externalBearerServerName: external.serverName,
  };
}

export function gitHubMcpReadOnly(context: McpAuthorizationContext): boolean {
  const header = Object.entries(mcpEffectiveConfig(context.server, context.binding).extraHeaders).find(
    ([name]) => name.toLowerCase() === "x-mcp-readonly",
  );
  return header !== undefined && !["", "false", "f", "no", "n", "0", "off"].includes(header[1].trim().toLowerCase());
}

export async function matchesGitHubMcpFence(transaction: DatabaseTransaction, expected: GitHubMcpAuthorityFence) {
  await transaction
    .select({ id: mcpServerAuthorizations.id })
    .from(mcpServerAuthorizations)
    .where(inArray(mcpServerAuthorizations.id, [expected.localAuthorizationId, expected.rootAuthorizationId]))
    .orderBy(asc(mcpServerAuthorizations.id))
    .for("update");
  const external = expected.externalBearerServerName
    ? { enabled: true, serverName: expected.externalBearerServerName }
    : undefined;
  const context = await readAgentGitHubMcp(transaction, expected.accountId, expected.agentId, external);
  const observed = context && gitHubMcpFence(context, external);
  return (
    observed?.mcpServerId === expected.mcpServerId && observed.authorizationVersion === expected.authorizationVersion
  );
}
