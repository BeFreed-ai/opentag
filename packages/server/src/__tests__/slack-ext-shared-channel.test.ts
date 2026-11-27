/*
 * BeFreed fork (patch S5): Slack's `is_ext_shared_channel` is recorded in the stored message's provider
 * context. It lives in the existing jsonb column, so older rows and older durable work payloads, which do not
 * have it, must keep parsing, and the strict runtime message ref must never receive it.
 */

import { ProviderInboundContextSchema, RuntimeProviderMessageRefSchema } from "@opentag/shared";
import { describe, expect, it } from "vitest";
import { runtimeProviderMessageRef } from "../runtime/runtime-provider-message-ref.js";
import { InboundWorkSchema } from "../services/im/inbound-work.js";
import { normalizeSlackEnvelope } from "../services/im-bindings/slack/adapter.js";
import { createSlackInboundWork, recoveredSlackEnvelope } from "../services/im-bindings/slack/inbound-work.js";

const installation = { appId: "A1", teamId: "T1", botUserId: "U_BOT", botId: "B_BOT" };
const event = { type: "app_mention", channel: "C1", channel_type: "channel", user: "U2", text: "hi", ts: "1.0" };

describe("provider context schema", () => {
  it.each([true, false])("accepts isExtSharedChannel=%s on the Slack variant", (flag) => {
    expect(ProviderInboundContextSchema.parse({ provider: "slack", isExtSharedChannel: flag })).toEqual({
      provider: "slack",
      isExtSharedChannel: flag,
    });
  });

  it("still parses a context stored before the field existed, and still rejects unknown keys", () => {
    expect(ProviderInboundContextSchema.parse({ provider: "slack", channelType: "im", threadTs: "1.0" })).toEqual({
      provider: "slack",
      channelType: "im",
      threadTs: "1.0",
    });
    expect(() => ProviderInboundContextSchema.parse({ provider: "slack", isExtShared: true })).toThrow();
    expect(() => ProviderInboundContextSchema.parse({ provider: "slack", isExtSharedChannel: "yes" })).toThrow();
  });
});

describe("normalising the envelope", () => {
  it.each([[true], [false]])("sets isExtSharedChannel=%s from the envelope", (flag) => {
    const [normalized] = normalizeSlackEnvelope({ eventId: "Ev1", ...installation, event, isExtSharedChannel: flag });
    expect(normalized?.providerContext).toEqual({
      provider: "slack",
      channelType: "channel",
      isExtSharedChannel: flag,
    });
  });

  it("omits the field when the envelope did not carry it", () => {
    const [normalized] = normalizeSlackEnvelope({ eventId: "Ev1", ...installation, event });
    expect(normalized?.providerContext).toEqual({ provider: "slack", channelType: "channel" });
    expect("isExtSharedChannel" in (normalized?.providerContext ?? {})).toBe(false);
  });
});

describe("durable inbound work", () => {
  const envelope = { type: "event_callback", event_id: "Ev1", event };

  it.each([[true], [false]])("round-trips the flag (%s) through storage and replay", (flag) => {
    const work = createSlackInboundWork(installation, { ...envelope, is_ext_shared_channel: flag }, null);
    expect(work.provider === "slack" && work.isExtSharedChannel).toBe(flag);
    const stored = InboundWorkSchema.parse(JSON.parse(JSON.stringify(work)));
    expect(stored.provider === "slack" && recoveredSlackEnvelope(stored).is_ext_shared_channel).toBe(flag);
  });

  it("round-trips an envelope without the flag as an envelope without it", () => {
    const work = createSlackInboundWork(installation, envelope, null);
    expect("isExtSharedChannel" in work).toBe(false);
    const stored = InboundWorkSchema.parse(JSON.parse(JSON.stringify(work)));
    expect(stored.provider === "slack" && "is_ext_shared_channel" in recoveredSlackEnvelope(stored)).toBe(false);
  });

  it("still parses work stored before the field existed", () => {
    const old = {
      version: 1,
      provider: "slack",
      appId: "A1",
      teamId: "T1",
      botUserId: "U_BOT",
      botId: "B_BOT",
      eventId: "Ev-old",
      identityClosed: true,
      revokesBot: false,
      event,
    };
    const parsed = InboundWorkSchema.parse(old);
    expect(parsed.provider === "slack" && parsed.isExtSharedChannel).toBeUndefined();
  });
});

describe("the runtime message ref", () => {
  const binding = {
    externalAppId: "A1",
    externalBotId: "U_BOT",
    externalTeamId: "T1",
    externalEnterpriseId: null,
    externalTeamBrand: null,
  } as never;

  it.each([[true], [false], [undefined]])(
    "never carries isExtSharedChannel (%s) and still satisfies the strict runtime schema",
    (flag) => {
      const ref = runtimeProviderMessageRef(
        {
          channelId: "C1",
          externalMessageId: "1.0",
          authorKind: "human",
          authorExternalId: "U2",
          providerContext: {
            provider: "slack",
            channelType: "channel",
            ...(flag === undefined ? {} : { isExtSharedChannel: flag }),
          },
        },
        binding,
      );
      expect("isExtSharedChannel" in ref).toBe(false);
      expect(RuntimeProviderMessageRefSchema.parse(ref)).toMatchObject({ provider: "slack", channelType: "channel" });
    },
  );
});
