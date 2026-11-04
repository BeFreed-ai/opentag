import { type ContextTreeConnection, contextTreeName, contextTreeSelector } from "@opentag/shared";
import { z } from "zod";

/**
 * Diagnostics for failed Context Tree gateway requests. Everything here is log-only: it records the
 * stage, error class and non-secret shape of the request, never argument values, request bodies,
 * tokens or environment.
 */
const STAGES = new WeakMap<object, string>();
const VALUE_FLAGS = new Set(["--tree", "--project-path", "--message"]);
const OPERATION_WORDS = new Set(["prepare", "finish", "abort"]);
const RELAY_OPEN_STAGES: Record<string, string> = {
  acquire_failed: "acquire_provider",
  ticket_failed: "ticket",
  data_connect_failed: "connect_data",
  provider_unavailable: "provider_unavailable",
};
const REDACTIONS = [/gh[pousr]_[A-Za-z0-9]+/g, /github_pat_\w+/g, /otrh_[\w-]+/g, /Bearer\s+\S+/g, /:\/\/[^/@\s]+@/g];

/** Marks the first (innermost) stage an error passed through; the error itself is returned unchanged. */
export function tagStage<T>(error: T, stage: string): T {
  if (typeof error === "object" && error !== null && !STAGES.has(error)) STAGES.set(error, stage);
  return error;
}

export function inStage<T>(stage: string, run: () => T): T {
  try {
    const result = run();
    if (result instanceof Promise)
      return result.catch((error: unknown) => {
        throw tagStage(error, stage);
      }) as T;
    return result;
  } catch (error) {
    throw tagStage(error, stage);
  }
}

export function redactMessage(message: string): string {
  let text = message;
  for (const pattern of REDACTIONS) text = text.replace(pattern, "<redacted>");
  return text.slice(0, 300);
}

export function rawArgs(body: unknown): readonly string[] | undefined {
  const args = typeof body === "object" && body !== null ? (body as { args?: unknown }).args : undefined;
  return Array.isArray(args) && args.every((arg) => typeof arg === "string") ? args.slice(0, 16) : undefined;
}

function argKind(args: readonly string[], index: number): string {
  const arg = args[index] as string;
  if (arg.startsWith("--")) return (arg.split("=")[0] as string).slice(0, 32);
  if (index === 0 && (arg === "sync" || arg === "write")) return arg;
  if (index === 1 && args[0] === "write" && OPERATION_WORDS.has(arg)) return arg;
  return "<positional>";
}

/** Argument kinds only: operation words and flag names, never a flag value or positional. */
function argKinds(args: readonly string[]): string[] {
  const kinds: string[] = [];
  for (let index = 0; index < args.length; index++) {
    kinds.push(argKind(args, index));
    if (VALUE_FLAGS.has(args[index] as string)) index++;
  }
  return kinds;
}

function stageOf(error: unknown): string {
  const object = typeof error === "object" && error !== null ? error : undefined;
  const stage = (object && STAGES.get(object)) || "unknown";
  const code = (object as { code?: unknown } | undefined)?.code;
  return stage === "open_child" && typeof code === "string" ? (RELAY_OPEN_STAGES[code] ?? stage) : stage;
}

function messageOf(error: unknown): string {
  // JSON syntax errors quote the request body and Zod messages may echo input, so neither is logged verbatim.
  if (error instanceof SyntaxError) return "<omitted: JSON syntax error>";
  if (error instanceof z.ZodError)
    return redactMessage(error.issues.map((issue) => `${issue.code}@${issue.path.join(".")}`).join(","));
  return redactMessage(error instanceof Error ? error.message : "non-Error thrown");
}

function codeFields(error: unknown): Record<string, string> {
  const fields: Record<string, string> = {};
  if (typeof error !== "object" || error === null) return fields;
  for (const key of ["code", "serverCode", "reason", "status"]) {
    const value = (error as Record<string, unknown>)[key];
    if (typeof value === "string" || typeof value === "number")
      fields[key] = redactMessage(String(value)).slice(0, 100);
  }
  return fields;
}

function treeFields(args: readonly string[], sources: readonly ContextTreeConnection[]): Record<string, unknown> {
  const tree = args.indexOf("--tree");
  if (tree < 0) return {};
  const selector = args[tree + 1];
  const matches = sources.filter(
    (source) =>
      selector === contextTreeSelector(source) ||
      selector === contextTreeName(source) ||
      selector?.toLowerCase() === source.repository.toLowerCase(),
  );
  return { treeSelectorMatched: selector !== undefined && matches.length === 1 };
}

function requestFields(args: readonly string[], sources: readonly ContextTreeConnection[]): Record<string, unknown> {
  const session = args[0] === "write" ? args[2] : undefined;
  return {
    argKinds: argKinds(args),
    hasProject: args.includes("--project-path"),
    ...treeFields(args, sources),
    ...(session && z.string().uuid().safeParse(session).success ? { sessionId: session } : {}),
  };
}

export function failureFields(
  error: unknown,
  args: readonly string[] | undefined,
  sources: readonly ContextTreeConnection[],
): Record<string, unknown> {
  return {
    stage: stageOf(error),
    errorName: error instanceof Error ? error.name : typeof error,
    errorMessage: messageOf(error),
    ...codeFields(error),
    ...(args ? requestFields(args, sources) : {}),
    sourcesCount: sources.length,
  };
}
