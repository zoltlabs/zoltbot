import { describe, expect, it } from "vitest";
import {
  type ApprovalPayload,
  approvalStdinHash,
  signApproval,
  verifyApproval,
} from "./approval.js";
import { createIdentity, toB64 } from "./crypto.js";

const now = 1800000000000;
const payload = (): ApprovalPayload => ({
  v: 1,
  orgId: "org",
  userId: "member",
  signerDeviceId: "phone",
  requestId: "request",
  taskId: "task",
  turnId: "turn",
  targetDeviceId: "mac",
  scope: "command",
  command: "uname",
  cwd: "/home/user/work/repo",
  stdinHash: approvalStdinHash(),
  timeoutSeconds: 600,
  issuedAt: now,
  expiresAt: now + 300000,
});
describe("signed Mac approvals", () => {
  it("verifies an exact approval against the registered device key independent of object insertion order", () => {
    const identity = createIdentity(),
      p = payload();
    const signed = signApproval(identity, p);
    const reordered = Object.fromEntries(Object.entries(p).reverse()) as unknown as ApprovalPayload;
    expect(verifyApproval(toB64(identity.publicKey), signed, reordered, now)).toBe(true);
    p.command = "false";
    expect(signed.payload.command).toBe("uname");
  });
  it.each([
    ["v", 2],
    ["orgId", "other"],
    ["userId", "other"],
    ["signerDeviceId", "other"],
    ["requestId", "other"],
    ["taskId", "other"],
    ["turnId", "other"],
    ["targetDeviceId", "other"],
    ["scope", "prefix"],
    ["command", "uname -a"],
    ["cwd", "/tmp"],
    ["stdinHash", approvalStdinHash("different")],
    ["timeoutSeconds", 1],
    ["issuedAt", now - 1],
    ["expiresAt", now + 1],
  ])("refuses changes to %s in either the relayed payload or the expected request", (field, value) => {
    const identity = createIdentity(),
      p = payload(),
      signed = signApproval(identity, p);
    const altered = { ...p, [field]: value } as ApprovalPayload;
    expect(
      verifyApproval(toB64(identity.publicKey), { ...signed, payload: altered }, altered, now),
    ).toBe(false);
    expect(verifyApproval(toB64(identity.publicKey), signed, altered, now)).toBe(false);
  });
  it("refuses forged, noncanonical, expired, future and malformed signatures", () => {
    const identity = createIdentity(),
      other = createIdentity(),
      p = payload();
    const signed = signApproval(identity, p),
      key = toB64(identity.publicKey);
    expect(verifyApproval(toB64(other.publicKey), signed, p, now)).toBe(false);
    expect(verifyApproval(key, { ...signed, signature: toB64(new Uint8Array(64)) }, p, now)).toBe(
      false,
    );
    expect(verifyApproval(key, signed, p, p.expiresAt)).toBe(false);
    expect(verifyApproval(key, signed, p, now - 30001)).toBe(false);
    expect(verifyApproval(`${key}=`, signed, p, now)).toBe(false);
    expect(verifyApproval(key, { ...signed, extra: true } as typeof signed, p, now)).toBe(false);
    expect(verifyApproval(key, null as unknown as typeof signed, p, now)).toBe(false);
    // A different spelling of the same signature bytes is not accepted.
    const last = signed.signature.at(-1) === "A" ? "B" : "R";
    expect(
      verifyApproval(key, { ...signed, signature: signed.signature.slice(0, -1) + last }, p, now),
    ).toBe(false);
  });
  it.each([
    { expiresAt: now + 300001 },
    { expiresAt: now },
    { issuedAt: NaN },
    { timeoutSeconds: 3601 },
    { cwd: "../repo" },
    { command: "" },
    { command: "x\0y" },
    { stdinHash: "plaintext" },
    { extra: true },
    { requestId: "x".repeat(201) },
  ])("refuses malformed signing input %#", (changes) => {
    expect(() => signApproval(createIdentity(), { ...payload(), ...changes })).toThrow(
      "approval_invalid",
    );
  });
  it("binds an explicit task prefix without treating it as permission to match arbitrary commands", () => {
    const identity = createIdentity(),
      p: ApprovalPayload = {
        ...payload(),
        scope: "prefix",
        command: "pnpm test",
        expiresAt: now + 86400000,
      };
    const signed = signApproval(identity, p);
    expect(verifyApproval(toB64(identity.publicKey), signed, p, now)).toBe(true);
    expect(
      verifyApproval(
        toB64(identity.publicKey),
        signed,
        { ...p, scope: "command", command: "pnpm test; false" },
        now,
      ),
    ).toBe(false);
  });
});
