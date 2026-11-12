import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha2";
import { utf8ToBytes } from "@noble/hashes/utils";
import type { MacApprovalPayload, SignedMacApproval } from "@zoltbot/protocol";
import { fromB64, type Identity, toB64 } from "./crypto.js";

/** Values displayed by the approving device, including execution options hidden by no default. */
export type ApprovalPayload = MacApprovalPayload;
export type SignedApproval = SignedMacApproval;
const fields = [
  "v",
  "orgId",
  "userId",
  "signerDeviceId",
  "requestId",
  "taskId",
  "turnId",
  "targetDeviceId",
  "scope",
  "command",
  "cwd",
  "stdinHash",
  "timeoutSeconds",
  "issuedAt",
  "expiresAt",
] as const;
const ids = [
  "orgId",
  "userId",
  "signerDeviceId",
  "requestId",
  "taskId",
  "turnId",
  "targetDeviceId",
] as const;
function valid(value: unknown): value is ApprovalPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  if (Object.keys(p).length !== fields.length || fields.some((field) => !Object.hasOwn(p, field)))
    return false;
  const text = (key: string, max: number) =>
    typeof p[key] === "string" &&
    p[key].length > 0 &&
    p[key].length <= max &&
    ![...p[key]].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
  return (
    p.v === 1 &&
    ids.every((key) => text(key, 200)) &&
    (p.scope === "command" || p.scope === "prefix") &&
    typeof p.command === "string" &&
    p.command.length > 0 &&
    p.command.length <= 16000 &&
    !p.command.includes("\0") &&
    text("cwd", 4096) &&
    (p.cwd as string).startsWith("/") &&
    typeof p.stdinHash === "string" &&
    /^[A-Za-z0-9_-]{43}$/u.test(p.stdinHash) &&
    Number.isInteger(p.timeoutSeconds) &&
    Number(p.timeoutSeconds) >= 1 &&
    Number(p.timeoutSeconds) <= 3600 &&
    Number.isSafeInteger(p.issuedAt) &&
    Number(p.issuedAt) >= 0 &&
    Number.isSafeInteger(p.expiresAt) &&
    Number(p.expiresAt) > Number(p.issuedAt) &&
    (p.scope !== "command" || Number(p.expiresAt) - Number(p.issuedAt) <= 300000)
  );
}
function canonical(payload: ApprovalPayload) {
  if (!valid(payload)) throw new Error("approval_invalid");
  // Fixed field order and a separate domain prevent signatures being reused as pairing proofs.
  return utf8ToBytes(
    JSON.stringify(["zoltbot-mac-approval-v1", ...fields.map((key) => payload[key])]),
  );
}
/** Hash the exact stdin bytes, including the distinction between empty and nonempty input. */
export function approvalStdinHash(stdin = "") {
  return toB64(sha256(utf8ToBytes(stdin)));
}
export function signApproval(identity: Identity, payload: ApprovalPayload): SignedApproval {
  try {
    const signature = toB64(ed25519.sign(canonical(payload), identity.secretKey));
    return { payload: structuredClone(payload), signature };
  } catch {
    throw new Error("approval_invalid");
  }
}
/** The caller supplies a pinned account key and expected scope; neither is trusted from the Cell. */
export function verifyApproval(
  publicKey: string,
  approval: SignedApproval,
  expected: ApprovalPayload,
  now = Date.now(),
) {
  try {
    if (
      !Number.isSafeInteger(now) ||
      now < 0 ||
      !valid(approval.payload) ||
      Object.keys(approval).length !== 2 ||
      !Object.hasOwn(approval, "payload") ||
      !Object.hasOwn(approval, "signature") ||
      typeof approval.signature !== "string" ||
      !/^[A-Za-z0-9_-]{86}$/u.test(approval.signature) ||
      !/^[A-Za-z0-9_-]{43}$/u.test(publicKey) ||
      approval.payload.issuedAt > now + 30000 ||
      approval.payload.expiresAt <= now
    )
      return false;
    const message = canonical(approval.payload),
      match = canonical(expected);
    if (message.length !== match.length || message.some((byte, i) => byte !== match[i]))
      return false;
    const key = fromB64(publicKey),
      signature = fromB64(approval.signature);
    if (toB64(key) !== publicKey || toB64(signature) !== approval.signature) return false;
    return ed25519.verify(signature, message, key, { zip215: false });
  } catch {
    return false;
  }
}
