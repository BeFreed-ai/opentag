/*
 * BeFreed fork (patch S4): test-only verifier for the signed principal.
 *
 * An independent re-implementation of the frozen contract's verifier rules. It imports nothing from the
 * signer, so a signer that drifts from the contract fails against it.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const sha256 = (body: string) => createHash("sha256").update(body, "utf8").digest("hex");

/**
 * The contract's verifier rules, written out independently of the signer: known key, |now - timestamp| <= 60,
 * `iat` equals the timestamp header, constant-time signature match over keyId.timestamp.principal.bodyhash,
 * and a `call` not seen before.
 */
export function verify(
  headers: Record<string, string>,
  body: string,
  options: { keys: Record<string, string>; nowMs: number; seen?: Set<string> },
): { ok: true; statement: Record<string, unknown> } | { ok: false; reason: string } {
  const lower = new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  const principalB64 = lower.get("x-opentag-principal");
  const keyId = lower.get("x-opentag-principal-key");
  const timestamp = lower.get("x-opentag-principal-timestamp");
  const signature = lower.get("x-opentag-principal-signature");
  if (!principalB64 || !keyId || !timestamp || !signature) return { ok: false, reason: "missing header" };
  const secret = options.keys[keyId];
  if (secret === undefined) return { ok: false, reason: "unknown key" };
  if (!/^\d+$/.test(timestamp)) return { ok: false, reason: "bad timestamp" };
  if (Math.abs(options.nowMs / 1000 - Number(timestamp)) > 60) return { ok: false, reason: "stale" };
  const signingString = `${keyId}.${timestamp}.${principalB64}.${sha256(body)}`;
  const expected = `v1=${createHmac("sha256", secret).update(signingString).digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "bad signature" };
  if (/[+/=]/.test(principalB64)) return { ok: false, reason: "not base64url without padding" };
  const statement = JSON.parse(Buffer.from(principalB64, "base64url").toString("utf8")) as Record<string, unknown>;
  if (statement.iat !== Number(timestamp)) return { ok: false, reason: "iat mismatch" };
  const call = String(statement.call);
  if (options.seen?.has(call)) return { ok: false, reason: "replay" };
  options.seen?.add(call);
  return { ok: true, statement };
}
