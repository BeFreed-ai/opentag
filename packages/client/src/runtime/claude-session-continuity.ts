import { type EffectiveRuntimeSnapshot, EffectiveRuntimeSnapshotSchema } from "@opentag/shared";

/**
 * A Claude Code conversation is identified by its workspace, execution policy and context trees, not by who
 * wrote its instructions or which model answers. Changing the Agent's or Session's revision, instructions,
 * self-configuration flag, model or reasoning effort therefore resumes the same native conversation (the new
 * values still apply on resume); changing anything else, or the provider, starts a fresh one.
 *
 * Without this every edit of an Agent's instructions or model discards the whole conversation context.
 */
const NON_IDENTITY_FIELDS = [
  "revision",
  "instructions",
  "selfConfigurationEnabled",
  "model",
  "reasoningEffort",
] as const;

export function claudeConversationContinues(
  current: { provider: string; runtimeBinding?: unknown },
  legacyLayout: unknown,
  stored: unknown,
  next: EffectiveRuntimeSnapshot,
): boolean {
  // A snapshot saved in a frozen legacy layout is compared by its own rules, never here.
  if (legacyLayout !== undefined) return false;
  if (current.provider !== "claude-code" || current.runtimeBinding === undefined || next.provider !== "claude-code") {
    return false;
  }
  const old = EffectiveRuntimeSnapshotSchema.safeParse(stored);
  if (!old.success || old.data.provider !== "claude-code") return false;
  return identity(old.data) === identity(next);
}

function identity(snapshot: EffectiveRuntimeSnapshot): string {
  const copy: Record<string, unknown> = { ...snapshot };
  for (const field of NON_IDENTITY_FIELDS) delete copy[field];
  return canonicalJson(copy);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}
