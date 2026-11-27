import {
  composeGatewayToolName,
  MCP_GATEWAY_MAX_TOOLS,
  type MCPToolSnapshot,
  MCPToolSnapshotSchema,
} from "@opentag/shared";
import { z } from "zod";
import type { ServiceLogger } from "../../observability/service-logger.js";
import {
  GATEWAY_PRINCIPAL_UNAVAILABLE,
  type GatewayPrincipal,
  type GatewayPrincipalSource,
  GatewayPrincipalUnavailableError,
} from "../../runtime-credentials/gateway-principal.js";
import type { RuntimeExecutionRecord } from "../../runtime-credentials/types.js";
import { MCP_ERROR_CODES, McpServiceError } from "./errors.js";
import { MCP_PRINCIPAL_MARKER_HEADER } from "./mcp-auth-headers.js";
import type { McpAuthorizationService } from "./mcp-authorization-service.js";
import type { McpUpstreamCaller } from "./mcp-gateway-upstream.js";
import { parseMcpParameterHeaders } from "./mcp-parameter-headers.js";
import { type McpJoinedBinding, McpServerService } from "./mcp-server-service.js";

/**
 * The runtime half of MCP: one Agent's bound Servers, presented as a single tool catalogue and a
 * single call entry point.
 *
 * Aggregation is transparent — a model sees `linear__create_issue`, not a `call_mcp_tool` meta tool
 * — because a model calls a tool it can read the schema of far more reliably than one it must first
 * discover through another call. The cost is context: this is why the catalogue is bounded.
 */

export interface McpGatewayTool {
  /** The composed, model-facing name. */
  name: string;
  description: string | null;
  inputSchema: unknown;
}

export interface McpGatewayCatalog {
  tools: McpGatewayTool[];
  /**
   * Human-readable notes about Servers that could not be included, surfaced to the model as the
   * MCP `instructions` string. A Server whose probe failed is a fact the model should know: without
   * it, a tool the user expects is simply absent with no explanation anywhere the model can see.
   */
  notes: string[];
}

export interface McpGatewayToolCallResult {
  /** The upstream `tools/call` result, forwarded structurally. */
  result: unknown;
}

export interface McpGatewayServiceOptions {
  servers: McpServerService;
  authorizations: McpAuthorizationService;
  upstream: McpUpstreamCaller;
  /** Bound on the published catalogue; overridable so a test can reach it cheaply. */
  maxTools?: number;
  /**
   * BeFreed fork (patch S4): signs the triggering principal for servers marked as requiring it. Absent
   * means no key and no derivation, so a call to a marked server fails closed.
   */
  principals?: GatewayPrincipalSource;
  /** Receives one structured line per `tools/call`, success or failure. */
  logger?: ServiceLogger;
}

/** A mount that is actually usable right now, with its composed tool names resolved. */
interface UsableMount {
  joined: McpJoinedBinding;
  serverName: string;
  tools: MCPToolSnapshot[];
}

export class McpGatewayService {
  readonly #servers: McpServerService;
  readonly #authorizations: McpAuthorizationService;
  readonly #upstream: McpUpstreamCaller;
  readonly #maxTools: number;
  readonly #principals: GatewayPrincipalSource | undefined;
  readonly #logger: ServiceLogger | undefined;

  constructor(options: McpGatewayServiceOptions) {
    this.#servers = options.servers;
    this.#authorizations = options.authorizations;
    this.#upstream = options.upstream;
    this.#maxTools = options.maxTools ?? MCP_GATEWAY_MAX_TOOLS;
    this.#principals = options.principals;
    this.#logger = options.logger;
  }

  /**
   * The Agent's whole tool catalogue, served from the stored probe snapshots.
   *
   * Reading the snapshot rather than fanning out a live `tools/list` to every bound Server is
   * deliberate. `tools/list` is called at the start of every run; a live fan-out would add one
   * round trip per Server to every turn and would contend for the same four-per-Account outbound
   * slots a real tool call needs. The snapshot is already the documented model — it is bounded at
   * 200 tools and 256 KiB per row, refreshed on every authorization change, and explicitly
   * described as a snapshot rather than an authoritative whole.
   */
  async catalog(accountId: string, agentId: string): Promise<McpGatewayCatalog> {
    const bindings = await this.#servers.listAgentBindings(accountId, agentId);
    const notes: string[] = [];
    const candidates = composeCandidates(usableMounts(bindings, notes));
    const claimants = claimantsByName(candidates);
    const tools: McpGatewayTool[] = [];
    const reported = new Set<string>();
    let truncated = false;
    for (const candidate of candidates) {
      const owners = claimants.get(candidate.name) ?? [];
      if (owners.length > 1) {
        if (!reported.has(candidate.name)) {
          reported.add(candidate.name);
          notes.push(`Tool "${candidate.name}" is unavailable: ${owners.join(" and ")} both produce that name.`);
        }
        continue;
      }
      if (tools.length >= this.#maxTools) {
        truncated = true;
        break;
      }
      tools.push({
        name: candidate.name,
        description: candidate.tool.description,
        inputSchema: candidate.tool.inputSchema ?? undefined,
      });
    }
    if (truncated) {
      notes.push(`Only the first ${this.#maxTools} tools are listed; some bound MCP Servers are not represented.`);
    }
    return { tools, notes };
  }

  /**
   * Route one `tools/call` to the Server that owns the composed name.
   *
   * The name is resolved by recomputing composed names over this Agent's own snapshots rather than
   * by splitting on the separator. Splitting would be wrong twice over: an upstream tool name may
   * itself contain the separator, and a shortened name does not contain its tool half at all. It
   * also means the resolution set is exactly what this Agent is allowed to call, so a name borrowed
   * from another Agent resolves to nothing rather than to someone else's Server.
   */
  async callTool(input: CallToolInput): Promise<McpGatewayToolCallResult> {
    const started = Date.now();
    const audit: CallAudit = { server: null, tool: null, principalKind: null, signed: false, callId: null, sends: 0 };
    try {
      const result = await this.#callTool(input, audit);
      this.#logCall(input, audit, started, undefined);
      return result;
    } catch (error) {
      this.#logCall(input, audit, started, error);
      throw error;
    }
  }

  /** One line per call: identifiers and outcome only, never headers, secrets, arguments or user ids. */
  #logCall(input: CallToolInput, audit: CallAudit, started: number, error: unknown): void {
    const failed = error !== undefined;
    const bindings = {
      code: "MCP_GATEWAY_TOOL_CALL",
      accountId: input.accountId,
      agentId: input.agentId,
      executionId: input.execution?.executionId ?? null,
      callId: audit.callId,
      sends: audit.sends,
      server: audit.server,
      tool: audit.tool,
      outcome: failed ? "failure" : "success",
      ...(failed ? { failure: failureCode(error) } : {}),
      durationMs: Date.now() - started,
      principalKind: audit.principalKind,
      signed: audit.signed,
    };
    if (failed) this.#logger?.warn(bindings, "MCP gateway tool call finished");
    else this.#logger?.info(bindings, "MCP gateway tool call finished");
  }

  async #callTool(input: CallToolInput, audit: CallAudit): Promise<McpGatewayToolCallResult> {
    const bindings = await this.#servers.listAgentBindings(input.accountId, input.agentId);
    const target = resolveTool(bindings, input.name);
    if (!target) {
      throw new McpServiceError(
        MCP_ERROR_CODES.BINDING_NOT_FOUND,
        `No MCP tool named "${input.name}" is available to this Agent`,
      );
    }
    audit.server = target.serverName;
    audit.tool = target.upstreamName;
    const mcpServerId = target.joined.server.id;
    const resolved = await this.#authorizations.resolveActiveCredential(input.accountId, input.agentId, mcpServerId);
    if (!resolved) {
      throw new McpServiceError(
        MCP_ERROR_CODES.AUTHORIZATION_REQUIRED,
        `This Agent is not authorized for the MCP Server "${target.serverName}"`,
      );
    }
    const effective = McpServerService.resolveEffectiveConfig(resolved.server, resolved.binding);
    const allowedTools = allowedToolsFromExtraHeaders(effective.extraHeaders);
    if (allowedTools && !allowedTools.has(target.upstreamName)) {
      throw new McpServiceError(
        MCP_ERROR_CODES.BINDING_NOT_FOUND,
        `No MCP tool named "${input.name}" is available to this Agent`,
      );
    }
    // Before any header is built or anything is sent: a marked server is never called unsigned.
    const signBody = await this.#principalSigner(input, effective.extraHeaders, target.upstreamName, audit);
    const headers = this.#authorizations.buildHeadersFor(resolved);
    const inputSchema = readToolSnapshot(resolved.authorization.tools).find(
      (tool) => tool.name === target.upstreamName,
    )?.inputSchema;
    const call = await this.#upstream.call({
      accountId: input.accountId,
      url: effective.url,
      authHeaders: headers,
      method: "tools/call",
      params: { name: target.upstreamName, arguments: input.arguments ?? {} },
      name: target.upstreamName,
      ...(inputSchema == null ? {} : { inputSchema }),
      cachedEra: resolved.authorization.protocolEra,
      cachedVersion: resolved.authorization.protocolVersion,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(signBody ? { signBody } : {}),
    });
    return { result: call.result };
  }

  /**
   * The per-request signer for a marked server, or `undefined` for an unmarked one (whose request is
   * then identical to what it was before this patch).
   *
   * Everything that can fail does so here, before the upstream is dialled: no key, no execution to
   * derive from, a derivation that throws, a marker with any value other than `required`, and a dry-run
   * signature that throws. Each is the same fixed error. The returned function signs one request body per
   * call and gives every request actually sent its own `call` id.
   */
  async #principalSigner(
    input: CallToolInput,
    extraHeaders: Record<string, string> | undefined,
    tool: string,
    audit: CallAudit,
  ): Promise<((bodySha256: string) => Record<string, string>) | undefined> {
    const marker = principalMarker(extraHeaders);
    if (marker === "absent") return undefined;
    try {
      const signer = this.#principals?.signer;
      if (marker === "invalid" || !signer || !this.#principals || !input.execution) {
        throw new GatewayPrincipalUnavailableError();
      }
      const execution = input.execution;
      const principal: GatewayPrincipal = await this.#principals.derive(execution);
      audit.principalKind = principal.kind;
      const context = {
        account: input.accountId,
        agent: input.agentId,
        execution: execution.executionId,
        tool,
        principal,
      };
      signer.sign(context, "0".repeat(64));
      return (bodySha256) => {
        try {
          const signed = signer.sign(context, bodySha256);
          audit.callId = signed.call;
          audit.sends += 1;
          audit.signed = true;
          return signed.headers;
        } catch {
          throw new GatewayPrincipalUnavailableError();
        }
      };
    } catch {
      throw new GatewayPrincipalUnavailableError();
    }
  }
}

interface CallToolInput {
  accountId: string;
  agentId: string;
  name: string;
  arguments?: Record<string, unknown>;
  signal?: AbortSignal;
  /** The authorized execution making the call; required to sign a principal (patch S4). */
  execution?: RuntimeExecutionRecord;
}

interface CallAudit {
  server: string | null;
  tool: string | null;
  principalKind: string | null;
  signed: boolean;
  callId: string | null;
  sends: number;
}

/** A bounded, secret-free label for why a call failed. */
function failureCode(error: unknown): string {
  if (error instanceof GatewayPrincipalUnavailableError) return GATEWAY_PRINCIPAL_UNAVAILABLE;
  if (error instanceof McpServiceError) return error.code;
  return "error";
}

/**
 * Whether the server asks for the signed principal: exactly `x-opentag-principal: required`, the name
 * compared case-insensitively. A marker with any other value is `invalid` rather than ignored, because a
 * typo must not silently turn the protection off.
 */
function principalMarker(extraHeaders: Record<string, string> | undefined): "absent" | "required" | "invalid" {
  if (!extraHeaders) return "absent";
  const entry = Object.entries(extraHeaders).find(([key]) => key.toLowerCase() === MCP_PRINCIPAL_MARKER_HEADER);
  if (!entry) return "absent";
  return entry[1] === "required" ? "required" : "invalid";
}

/**
 * The mounts whose tools may be published, in the order the join returned them.
 *
 * Three independent conditions must hold, and each failure is reported rather than swallowed,
 * because "my tool disappeared" is otherwise indistinguishable between a disabled mount, a revoked
 * credential, and an MCP Server that stopped answering.
 */
function usableMounts(bindings: readonly McpJoinedBinding[], notes: string[]): UsableMount[] {
  const usable: UsableMount[] = [];
  for (const joined of bindings) {
    const serverName = joined.server.name;
    if (!joined.binding.enabled) continue;
    const authorization = joined.authorization;
    if (authorization?.status !== "active") {
      notes.push(`MCP Server "${serverName}" is not authorized for this Agent, so its tools are unavailable.`);
      continue;
    }
    if (authorization.probeState !== "succeeded") {
      notes.push(
        `MCP Server "${serverName}" has no usable tool snapshot (${authorization.probeState}), so its tools are unavailable.`,
      );
      continue;
    }
    const effective = McpServerService.resolveEffectiveConfig(joined.server, joined.binding);
    const tools = usableToolSnapshot(
      authorization,
      serverName,
      notes,
      allowedToolsFromExtraHeaders(effective.extraHeaders),
    );
    if (tools.length === 0) continue;
    usable.push({ joined, serverName, tools });
  }
  return usable;
}

const LARK_MCP_ALLOWED_TOOLS_HEADER = "x-lark-mcp-allowed-tools";

function allowedToolsFromExtraHeaders(
  extraHeaders: Record<string, string> | undefined,
): ReadonlySet<string> | undefined {
  if (!extraHeaders) return undefined;
  const entry = Object.entries(extraHeaders).find(([key]) => key.toLowerCase() === LARK_MCP_ALLOWED_TOOLS_HEADER);
  if (!entry) return undefined;
  return new Set(
    entry[1]
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
  );
}

function usableToolSnapshot(
  authorization: NonNullable<McpJoinedBinding["authorization"]>,
  serverName: string,
  notes: string[],
  allowedTools?: ReadonlySet<string>,
): MCPToolSnapshot[] {
  const rawTools = readToolSnapshot(authorization.tools);
  const tools = allowedTools ? rawTools.filter((tool) => allowedTools.has(tool.name)) : rawTools;
  if (authorization.protocolEra === "legacy") return tools;
  return tools.filter((tool) => {
    const parsed = parseMcpParameterHeaders(tool.inputSchema);
    if (parsed.valid) return true;
    notes.push(`MCP tool "${composeGatewayToolName(serverName, tool.name)}" was excluded: ${parsed.reason}.`);
    return false;
  });
}

interface ToolCandidate {
  name: string;
  serverName: string;
  tool: MCPToolSnapshot;
}

/** Every tool of every usable mount, with its model-facing name already composed. */
function composeCandidates(mounts: readonly UsableMount[]): ToolCandidate[] {
  return mounts.flatMap((mount) =>
    mount.tools.map((tool) => ({
      name: composeGatewayToolName(mount.serverName, tool.name),
      serverName: mount.serverName,
      tool,
    })),
  );
}

/**
 * Which Servers claim each composed name.
 *
 * Counted across every mount before anything is published, because a collision can only be judged
 * once both sides are known. Publishing the first arrival and dropping the second — what an
 * as-you-go check does — leaves a tool in the catalogue that can never be called: `dispatchToolCall`
 * resolves over the same snapshots, finds two matches and refuses. Withholding both and saying so is
 * better than advertising one that always fails.
 */
function claimantsByName(candidates: readonly ToolCandidate[]): Map<string, string[]> {
  const claimants = new Map<string, string[]>();
  for (const candidate of candidates) {
    claimants.set(candidate.name, [...(claimants.get(candidate.name) ?? []), candidate.serverName]);
  }
  return claimants;
}

/** Recompute composed names over the Agent's usable mounts and find the exact match. */
function resolveTool(
  bindings: readonly McpJoinedBinding[],
  name: string,
): { joined: McpJoinedBinding; serverName: string; upstreamName: string } | undefined {
  const matches: { joined: McpJoinedBinding; serverName: string; upstreamName: string }[] = [];
  for (const mount of usableMounts(bindings, [])) {
    for (const tool of mount.tools) {
      if (composeGatewayToolName(mount.serverName, tool.name) !== name) continue;
      matches.push({ joined: mount.joined, serverName: mount.serverName, upstreamName: tool.name });
    }
  }
  // An ambiguous name was never published (see `catalog`), so refusing here keeps the two paths
  // agreeing rather than letting a call reach a Server the catalogue declined to name.
  return matches.length === 1 ? matches[0] : undefined;
}

const ToolSnapshotArraySchema = z.array(MCPToolSnapshotSchema);

/**
 * Read the stored tool snapshot back out of its jsonb column.
 *
 * The column is untyped at the database boundary, and the probe that wrote it may have run against
 * an older bound. Parsing rather than casting means a row written by a past version cannot put a
 * malformed tool into a live catalogue; an unreadable snapshot degrades to "this Server contributes
 * nothing" instead of to a tool whose name or schema the caller cannot trust.
 */
function readToolSnapshot(value: unknown): MCPToolSnapshot[] {
  const parsed = ToolSnapshotArraySchema.safeParse(value ?? []);
  return parsed.success ? parsed.data : [];
}
