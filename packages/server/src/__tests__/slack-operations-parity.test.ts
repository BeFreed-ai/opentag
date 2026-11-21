import { describe, expect, it } from "vitest";
import { ProviderOperationRegistry } from "../runtime-credentials/operation-registry.js";
import { SLACK_OPERATIONS } from "../runtime-credentials/slack-operations.js";

// Every Slack Web API method an OpenTag agent was seen calling through `opentag slack api` (the vid3o agent's
// history, 2026-11-21). The proxy answers a method outside its table with HTTP 503, which an agent cannot tell
// from an outage, so a method an agent really uses must stay in the table.
const METHODS_AGENTS_USE = [
  "chat.postMessage", "chat.update", "chat.delete", "chat.getPermalink", "chat.scheduleMessage",
  "chat.scheduledMessages.list", "chat.deleteScheduledMessage",
  "conversations.history", "conversations.replies", "conversations.list", "conversations.info",
  "conversations.members", "conversations.open", "conversations.join",
  "files.info", "files.list", "files.delete", "files.getUploadURLExternal", "files.completeUploadExternal",
  "reactions.add", "reactions.remove", "reactions.get",
  "users.info", "users.list", "users.conversations",
  "team.info", "auth.test", "search.messages", "search.files",
];

describe("Slack operation table", () => {
  const ids = new Set(SLACK_OPERATIONS.map((operation) => operation.operationId));

  it.each(METHODS_AGENTS_USE)("carries %s", (method) => {
    expect(ids.has(method)).toBe(true);
  });

  it("keeps one entry per method and still refuses admin, OAuth and app-management methods", () => {
    expect(ids.size).toBe(SLACK_OPERATIONS.length);
    for (const method of ["admin.users.list", "oauth.v2.access", "apps.manifest.update", "auth.revoke", "users.admin.invite"]) {
      expect(ids.has(method)).toBe(false);
    }
    expect(() => new ProviderOperationRegistry(SLACK_OPERATIONS)).not.toThrow();
  });

  it("marks files.delete as a write and the new lookups as reads", () => {
    const kind = (id: string) => SLACK_OPERATIONS.find((operation) => operation.operationId === id)?.kind;
    expect(kind("files.delete")).toBe("write");
    for (const id of ["chat.getPermalink", "files.list", "users.conversations", "search.messages", "search.files"]) {
      expect(kind(id)).toBe("read");
    }
  });
});
