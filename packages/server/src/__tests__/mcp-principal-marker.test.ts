/*
 * BeFreed fork (patch S4): the marker header `x-opentag-principal: required` is configuration for the gateway
 * and is never sent: not on a tool call, not on the probe's `server/discover` and `tools/list`.
 */

import { describe, expect, it, vi } from "vitest";
import { buildMcpAuthHeaders, MCP_PRINCIPAL_MARKER_HEADER } from "../services/mcp/mcp-auth-headers.js";
import { McpProbe } from "../services/mcp/mcp-probe.js";
import { McpOutboundFetcher } from "../services/mcp/mcp-url-policy.js";

const PUBLIC_RESOLVE = { resolveAddresses: async (): Promise<string[]> => ["93.184.216.34"] };

describe("buildMcpAuthHeaders", () => {
  it.each(["x-opentag-principal", "X-OpenTag-Principal"])(
    "drops the marker header (%s) and keeps the others",
    (name) => {
      const headers = buildMcpAuthHeaders({
        kind: "bearer",
        authHeader: "authorization",
        authScheme: "Bearer",
        extraHeaders: { [name]: "required", "x-workspace": "w1" },
        bearerKey: "key",
      });
      expect(Object.keys(headers).map((header) => header.toLowerCase())).not.toContain(MCP_PRINCIPAL_MARKER_HEADER);
      expect(Object.values(headers)).not.toContain("required");
      expect(headers).toEqual({ authorization: "Bearer key", "x-workspace": "w1" });
    },
  );

  it("drops the marker for a server with no credential too", () => {
    const headers = buildMcpAuthHeaders({
      kind: "none",
      authHeader: "authorization",
      authScheme: "Bearer",
      extraHeaders: { "x-opentag-principal": "required" },
    });
    expect(headers).toEqual({});
  });
});

describe("probe requests to a marked server", () => {
  it("carry no marker on server/discover or tools/list", async () => {
    const seen: { method: string; headers: Record<string, string> }[] = [];
    const fetchImpl = vi.fn(async (_url: URL | string, init?: RequestInit) => {
      const method = (JSON.parse(String(init?.body)) as { method?: string }).method ?? "";
      seen.push({ method, headers: { ...((init?.headers ?? {}) as Record<string, string>) } });
      const result =
        method === "server/discover"
          ? { supportedVersions: ["2026-07-28"], capabilities: { tools: {} }, serverInfo: { name: "x", version: "1" } }
          : { tools: [{ name: "send", inputSchema: { type: "object" } }] };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: "1", result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;
    const probe = new McpProbe({
      fetcher: new McpOutboundFetcher({ ...PUBLIC_RESOLVE, allowLoopback: false, fetch: fetchImpl }),
    });
    await probe.probe({
      accountId: "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e",
      url: "https://mcp.example.com/mcp",
      authHeaders: buildMcpAuthHeaders({
        kind: "bearer",
        authHeader: "authorization",
        authScheme: "Bearer",
        extraHeaders: { "x-opentag-principal": "required" },
        bearerKey: "key",
      }),
      cachedEra: null,
      cachedVersion: null,
    });
    expect(seen.map((request) => request.method)).toEqual(expect.arrayContaining(["server/discover", "tools/list"]));
    for (const request of seen) {
      expect(Object.keys(request.headers).map((name) => name.toLowerCase())).not.toContain("x-opentag-principal");
      expect(Object.values(request.headers)).not.toContain("required");
    }
  });
});
