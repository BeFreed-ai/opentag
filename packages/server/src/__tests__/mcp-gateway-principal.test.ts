/*
 * BeFreed fork (patch S4): the gateway signs the principal on tool calls to a marked MCP server.
 *
 * The real service, the real upstream caller, the real transport and the real header builder run here;
 * only the network (a scripted fetcher that records the raw bytes it was handed) and the database (a fake
 * derivation) are replaced. The verifier is the independent one in `support/`.
 */

import { MCP_LEGACY_PROTOCOL_VERSIONS, MCP_MODERN_PROTOCOL_VERSION } from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
import type { ServiceLogger } from "../observability/service-logger.js";
import {
  type GatewayPrincipal,
  GatewayPrincipalSigner,
  type GatewayPrincipalSource,
  GatewayPrincipalUnavailableError,
} from "../runtime-credentials/gateway-principal.js";
import type { RuntimeExecutionRecord } from "../runtime-credentials/types.js";
import { buildMcpAuthHeaders } from "../services/mcp/mcp-auth-headers.js";
import type { McpAuthorizationService } from "../services/mcp/mcp-authorization-service.js";
import { McpGatewayService } from "../services/mcp/mcp-gateway-service.js";
import { McpUpstreamCaller } from "../services/mcp/mcp-gateway-upstream.js";
import type { McpJoinedBinding, McpServerService } from "../services/mcp/mcp-server-service.js";
import type { McpFetchInit, McpFetchResponse, McpOutboundFetcher } from "../services/mcp/mcp-url-policy.js";
import { verify } from "./support/gateway-principal-verifier.js";

const ACCOUNT = "account-1";
const AGENT = "agent-1";
const SECRET = "s3cr3t-signing-key-0123456789-abcdefghij";
const KEYS = { "ot-test": SECRET };
const NOW_MS = Date.UTC(2026, 10, 27, 1, 0, 0);
const EXECUTION = { executionId: "exec-1", accountId: ACCOUNT, agentId: AGENT } as unknown as RuntimeExecutionRecord;
const PRINCIPAL: GatewayPrincipal = {
  kind: "human",
  provider: "slack",
  team: "T-SECRET-TEAM",
  user: "U-SECRET-USER",
  channel: "C-SECRET-CHANNEL",
  shared_channel: false,
  schedule_id: null,
  via_session: null,
  creator: null,
};
const SECRET_ARGUMENT = "ARGUMENT-VALUE-MUST-NOT-BE-LOGGED";

interface Sent {
  method: string;
  headers: Record<string, string>;
  rawBody: string;
}

/** A fetcher scripted by request, recording exactly what the transport handed it. */
function scriptedFetcher(script: (body: Record<string, unknown>, sent: Sent[]) => McpFetchResponse) {
  const sent: Sent[] = [];
  const fetcher = {
    fetchOutbound: async (_accountId: string, _url: string, init: McpFetchInit = {}): Promise<McpFetchResponse> => {
      const rawBody = String(init.body ?? "");
      const body = JSON.parse(rawBody) as Record<string, unknown>;
      sent.push({
        method: String(body.method ?? ""),
        headers: { ...((init.headers ?? {}) as Record<string, string>) },
        rawBody,
      });
      return script(body, sent);
    },
  } as unknown as McpOutboundFetcher;
  return { fetcher, sent };
}

const ok = (body: Record<string, unknown>, result: unknown): McpFetchResponse => ({
  status: 200,
  headers: new Headers({ "content-type": "application/json" }),
  text: JSON.stringify({ jsonrpc: "2.0", id: body.id, result }),
});

const fail = (body: Record<string, unknown>, status: number, error: unknown): McpFetchResponse => ({
  status,
  headers: new Headers({ "content-type": "application/json" }),
  text: JSON.stringify({ jsonrpc: "2.0", id: body.id, error }),
});

function mount(options: { extraHeaders?: Record<string, string>; era?: "modern" | "legacy" }): McpJoinedBinding {
  const era = options.era ?? "modern";
  return {
    agent: { id: AGENT, name: "agent", displayName: "Agent" },
    localAuthorization: null,
    credentialAuthorization: null,
    binding: {
      agentId: AGENT,
      mcpServerId: "server-1",
      enabled: true,
      urlOverride: null,
      authHeaderOverride: null,
      authSchemeOverride: null,
      extraHeadersOverride: null,
    } as McpJoinedBinding["binding"],
    server: {
      id: "server-1",
      name: "gate",
      accountId: ACCOUNT,
      url: "https://gate.example.com/mcp",
      authHeader: "authorization",
      authScheme: "Bearer",
      extraHeaders: options.extraHeaders ?? {},
    } as McpJoinedBinding["server"],
    authorization: {
      mcpServerId: "server-1",
      agentId: AGENT,
      kind: "bearer",
      status: "active",
      probeState: "succeeded",
      protocolEra: era,
      protocolVersion: era === "modern" ? MCP_MODERN_PROTOCOL_VERSION : MCP_LEGACY_PROTOCOL_VERSIONS[0],
      tools: [{ name: "send", description: null, inputSchema: null }],
    } as McpJoinedBinding["authorization"],
  };
}

function harness(options: {
  extraHeaders?: Record<string, string>;
  era?: "modern" | "legacy";
  signer?: GatewayPrincipalSigner | null;
  derive?: GatewayPrincipalSource["derive"];
  withPrincipals?: boolean;
  script?: Parameters<typeof scriptedFetcher>[0];
}) {
  const joined = mount(options);
  const { fetcher, sent } = scriptedFetcher(
    options.script ?? ((body) => ok(body, { content: [{ type: "text", text: "done" }] })),
  );
  const servers = { listAgentBindings: vi.fn(async () => [joined]) } as unknown as McpServerService;
  const authorizations = {
    resolveActiveCredential: vi.fn(async () => ({
      binding: joined.binding,
      server: joined.server,
      authorization: joined.authorization,
    })),
    // The real header builder, so the marker is stripped by the same code production uses.
    buildHeadersFor: vi.fn(() =>
      buildMcpAuthHeaders({
        kind: "bearer",
        authHeader: "authorization",
        authScheme: "Bearer",
        extraHeaders: joined.server.extraHeaders as Record<string, string>,
        bearerKey: "upstream-key",
      }),
    ),
  } as unknown as McpAuthorizationService;
  const derive = vi.fn(options.derive ?? (async () => PRINCIPAL));
  const signer =
    options.signer === null
      ? undefined
      : (options.signer ?? new GatewayPrincipalSigner(new Map(Object.entries(KEYS)), "ot-test", () => NOW_MS));
  const logs: { level: string; bindings: Record<string, unknown>; message: string }[] = [];
  const logger: ServiceLogger = {
    debug: (bindings, message) => logs.push({ level: "debug", bindings, message }),
    info: (bindings, message) => logs.push({ level: "info", bindings, message }),
    warn: (bindings, message) => logs.push({ level: "warn", bindings, message }),
    error: (bindings, message) => logs.push({ level: "error", bindings, message }),
  };
  const service = new McpGatewayService({
    servers,
    authorizations,
    upstream: new McpUpstreamCaller({ fetcher }),
    ...(options.withPrincipals === false ? {} : { principals: { signer, derive } }),
    logger,
  });
  const callTool = (execution: RuntimeExecutionRecord | undefined = EXECUTION) =>
    service.callTool({
      accountId: ACCOUNT,
      agentId: AGENT,
      name: "gate__send",
      arguments: { text: SECRET_ARGUMENT },
      ...(execution ? { execution } : {}),
    });
  return { callTool, sent, derive, logs, signer };
}

const MARKED = { "x-opentag-principal": "required" };

describe("a marked server", () => {
  it("receives four headers that an independent verifier accepts over the exact bytes sent", async () => {
    const { callTool, sent } = harness({ extraHeaders: MARKED });
    await callTool();
    expect(sent).toHaveLength(1);
    const request = sent[0] as Sent;
    expect(request.method).toBe("tools/call");
    const verdict = verify(request.headers, request.rawBody, { keys: KEYS, nowMs: NOW_MS });
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.statement).toMatchObject({
      account: ACCOUNT,
      agent: AGENT,
      execution: "exec-1",
      tool: "send",
      principal: PRINCIPAL,
    });
    // The upstream credential still travels.
    expect(request.headers.authorization).toBe("Bearer upstream-key");
  });

  it("does not forward the marker header: the only header of that name carries the principal", async () => {
    const { callTool, sent } = harness({ extraHeaders: MARKED });
    await callTool();
    const headers = (sent[0] as Sent).headers;
    const named = Object.entries(headers).filter(([name]) => name.toLowerCase() === "x-opentag-principal");
    expect(named).toHaveLength(1);
    expect(named[0]?.[1]).not.toBe("required");
    expect(Object.values(headers)).not.toContain("required");
  });

  it("replaces a same-named extra header of any case instead of sending two", async () => {
    const { callTool, sent } = harness({
      extraHeaders: { ...MARKED, "x-opentag-principal-key": "evil", "x-opentag-principal-signature": "v1=00" },
    });
    await callTool();
    const request = sent[0] as Sent;
    const names = Object.keys(request.headers).map((name) => name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    expect(Object.values(request.headers)).not.toContain("evil");
    expect(verify(request.headers, request.rawBody, { keys: KEYS, nowMs: NOW_MS }).ok).toBe(true);
  });

  it("signs the tools/call of a legacy peer over its own body, and leaves the handshake unsigned", async () => {
    const { callTool, sent } = harness({
      extraHeaders: MARKED,
      era: "legacy",
      script: (body) =>
        body.method === "initialize"
          ? ok(body, { protocolVersion: MCP_LEGACY_PROTOCOL_VERSIONS[0], capabilities: {} })
          : body.method === "notifications/initialized"
            ? ({ status: 202, headers: new Headers(), text: "" } as McpFetchResponse)
            : ok(body, { content: [] }),
    });
    await callTool();
    expect(sent.map((request) => request.method)).toEqual(["initialize", "notifications/initialized", "tools/call"]);
    for (const request of sent.slice(0, 2)) {
      expect(Object.keys(request.headers).some((name) => name.toLowerCase().startsWith("x-opentag-principal"))).toBe(
        false,
      );
    }
    const call = sent[2] as Sent;
    expect(verify(call.headers, call.rawBody, { keys: KEYS, nowMs: NOW_MS }).ok).toBe(true);
  });

  it("signs the protocol-version retry separately: its body differs and so does its call id", async () => {
    const { callTool, sent } = harness({
      extraHeaders: MARKED,
      script: (body, requests) =>
        requests.length === 1
          ? fail(body, 400, {
              code: -32022,
              message: "unsupported",
              data: { supported: [MCP_MODERN_PROTOCOL_VERSION] },
            })
          : ok(body, { content: [] }),
    });
    // The first request is refused as a version mismatch; the retry is the one that succeeds.
    await expect(callTool()).resolves.toMatchObject({ result: { content: [] } });
    expect(sent).toHaveLength(2);
    expect((sent[0] as Sent).rawBody).not.toBe((sent[1] as Sent).rawBody);
    const seen = new Set<string>();
    for (const request of sent) {
      expect(verify(request.headers, request.rawBody, { keys: KEYS, nowMs: NOW_MS, seen }).ok).toBe(true);
    }
    expect(seen.size).toBe(sent.length);
  });

  it("each tool call gets a new call id", async () => {
    const { callTool, sent } = harness({ extraHeaders: MARKED });
    await callTool();
    await callTool();
    const seen = new Set<string>();
    for (const request of sent) {
      expect(verify(request.headers, request.rawBody, { keys: KEYS, nowMs: NOW_MS, seen }).ok).toBe(true);
    }
    expect(seen.size).toBe(2);
  });
});

describe("an unmarked server", () => {
  it("gets no principal header and exactly the request it got before, without touching derivation", async () => {
    const withPatch = harness({ extraHeaders: { "x-workspace": "w1" } });
    const withoutPatch = harness({ extraHeaders: { "x-workspace": "w1" }, withPrincipals: false });
    await withPatch.callTool();
    await withoutPatch.callTool();
    const a = withPatch.sent[0] as Sent;
    const b = withoutPatch.sent[0] as Sent;
    expect(a.headers).toEqual(b.headers);
    // The JSON-RPC id is a fresh random uuid per request; everything else is byte-identical.
    const normalise = (raw: string) => raw.replace(/"id":"[0-9a-f-]{36}"/, '"id":"ID"');
    expect(normalise(a.rawBody)).toBe(normalise(b.rawBody));
    expect(Object.keys(a.headers).some((name) => name.toLowerCase().startsWith("x-opentag-principal"))).toBe(false);
    expect(withPatch.derive).not.toHaveBeenCalled();
  });

  it("works when the gateway has no principal source at all", async () => {
    const { callTool, sent } = harness({ withPrincipals: false });
    await expect(callTool()).resolves.toMatchObject({ result: { content: [{ type: "text", text: "done" }] } });
    expect(sent).toHaveLength(1);
  });
});

describe("failing closed", () => {
  const cases: [string, Parameters<typeof harness>[0]][] = [
    ["no signing key is configured", { extraHeaders: MARKED, signer: null }],
    ["the gateway has no principal source", { extraHeaders: MARKED, withPrincipals: false }],
    [
      "derivation throws",
      {
        extraHeaders: MARKED,
        derive: async () => {
          throw new Error("database is down");
        },
      },
    ],
    ["the marker value is not exactly 'required'", { extraHeaders: { "x-opentag-principal": "true" } }],
    [
      "signing throws",
      {
        extraHeaders: MARKED,
        signer: {
          sign: () => {
            throw new Error("hsm unavailable");
          },
        } as unknown as GatewayPrincipalSigner,
      },
    ],
  ];

  it.each(cases)("sends nothing upstream when %s", async (_label, options) => {
    const { callTool, sent } = harness(options);
    await expect(callTool()).rejects.toBeInstanceOf(GatewayPrincipalUnavailableError);
    expect(sent).toHaveLength(0);
  });

  it("sends nothing upstream when no execution is supplied to derive from", async () => {
    const { callTool, sent } = harness({ extraHeaders: MARKED });
    await expect(callTool(null as never)).rejects.toBeInstanceOf(GatewayPrincipalUnavailableError);
    expect(sent).toHaveLength(0);
  });

  it("sends nothing upstream on a legacy peer either: not even the handshake", async () => {
    const { callTool, sent } = harness({ extraHeaders: MARKED, era: "legacy", signer: null });
    await expect(callTool()).rejects.toBeInstanceOf(GatewayPrincipalUnavailableError);
    expect(sent).toHaveLength(0);
  });

  it("uses one fixed error that names no cause", async () => {
    const { callTool } = harness({
      extraHeaders: MARKED,
      derive: async () => {
        throw new Error("password=hunter2");
      },
    });
    const error = (await callTool().catch((caught) => caught)) as GatewayPrincipalUnavailableError;
    expect(error.gatewayCode).toBe("principal_unavailable");
    expect(error.message).not.toContain("hunter2");
    expect(error.cause).toBeUndefined();
  });
});

describe("the audit log line", () => {
  const forbidden = [
    SECRET,
    SECRET_ARGUMENT,
    "U-SECRET-USER",
    "T-SECRET-TEAM",
    "C-SECRET-CHANNEL",
    "upstream-key",
    "v1=",
  ];

  it("is written once for a success, with the identifying fields and nothing sensitive", async () => {
    const { callTool, logs } = harness({ extraHeaders: MARKED });
    await callTool();
    expect(logs).toHaveLength(1);
    const line = logs[0] as (typeof logs)[number];
    expect(line.bindings).toMatchObject({
      accountId: ACCOUNT,
      agentId: AGENT,
      executionId: "exec-1",
      server: "gate",
      tool: "send",
      outcome: "success",
      principalKind: "human",
      signed: true,
      sends: 1,
    });
    expect(line.bindings.callId).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof line.bindings.durationMs).toBe("number");
    const text = JSON.stringify(line);
    for (const value of forbidden) expect(text).not.toContain(value);
  });

  it("is written once for a failure, with the failure label and nothing sensitive", async () => {
    const { callTool, logs } = harness({ extraHeaders: MARKED, signer: null });
    await callTool().catch(() => undefined);
    expect(logs).toHaveLength(1);
    const line = logs[0] as (typeof logs)[number];
    expect(line.bindings).toMatchObject({
      outcome: "failure",
      failure: "principal_unavailable",
      server: "gate",
      tool: "send",
      signed: false,
    });
    const text = JSON.stringify(line);
    for (const value of forbidden) expect(text).not.toContain(value);
  });

  it("is written for an unmarked server as well, as unsigned", async () => {
    const { callTool, logs } = harness({});
    await callTool();
    expect(logs).toHaveLength(1);
    expect((logs[0] as (typeof logs)[number]).bindings).toMatchObject({
      outcome: "success",
      signed: false,
      principalKind: null,
      server: "gate",
    });
  });

  it("is written when the upstream itself fails", async () => {
    const { callTool, logs } = harness({
      extraHeaders: MARKED,
      script: (body) => fail(body, 500, { code: -32603, message: "boom" }),
    });
    await callTool().catch(() => undefined);
    expect(logs).toHaveLength(1);
    expect((logs[0] as (typeof logs)[number]).bindings).toMatchObject({ outcome: "failure", signed: true });
  });
});
