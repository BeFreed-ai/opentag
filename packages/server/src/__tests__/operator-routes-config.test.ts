import { describe, expect, it } from "vitest";
import { OperatorRoutesConfigError, parseOperatorRoutesConfig } from "../operator-routes-config.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

describe("parseOperatorRoutesConfig (BeFreed fork)", () => {
  it("is off by default and exposes no allow-list", () => {
    expect(parseOperatorRoutesConfig({})).toEqual({ enabled: false, allowedUserIds: new Set() });
  });

  it("ignores a leftover allow-list while disabled", () => {
    const config = parseOperatorRoutesConfig({
      OPENTAG_OPERATOR_ROUTES_ENABLED: "false",
      OPENTAG_OPERATOR_USER_IDS: A,
    });
    expect(config).toEqual({ enabled: false, allowedUserIds: new Set() });
  });

  it("parses a trimmed, case-folded, de-duplicated list when enabled", () => {
    const config = parseOperatorRoutesConfig({
      OPENTAG_OPERATOR_ROUTES_ENABLED: "true",
      OPENTAG_OPERATOR_USER_IDS: ` ${A.toUpperCase()}, ${B} ,,${A}`,
    });
    expect(config.enabled).toBe(true);
    expect([...config.allowedUserIds].sort()).toEqual([A, B]);
  });

  it("fails closed: enabled with no ids, a bad flag value, or a bad id never silently starts", () => {
    expect(() => parseOperatorRoutesConfig({ OPENTAG_OPERATOR_ROUTES_ENABLED: "true" })).toThrow(
      OperatorRoutesConfigError,
    );
    expect(() => parseOperatorRoutesConfig({ OPENTAG_OPERATOR_ROUTES_ENABLED: "yes" })).toThrow(
      OperatorRoutesConfigError,
    );
    expect(() =>
      parseOperatorRoutesConfig({
        OPENTAG_OPERATOR_ROUTES_ENABLED: "true",
        OPENTAG_OPERATOR_USER_IDS: "someone@example.com",
      }),
    ).toThrow(/entry 1 must be a user id/);
  });

  it("never echoes a bad value", () => {
    try {
      parseOperatorRoutesConfig({ OPENTAG_OPERATOR_USER_IDS: "super-secret-looking-value" });
      throw new Error("expected throw");
    } catch (error) {
      expect(String((error as Error).message)).not.toContain("super-secret");
    }
  });
});
