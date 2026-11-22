import { approvalStdinHash, createIdentity, linkId, toB64, verifyApproval } from "@zoltbot/link";
import type { Interaction } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { cloudAnswer, cloudRequests, macRequestDetails } from "./needs-you.js";

const identity = createIdentity();
const owner = {
  userId: "member",
  orgId: "personal",
  sessionId: "session",
  deviceId: linkId(identity.publicKey),
};
const now = Date.parse("2026-11-20T12:00:00Z");
const request: Interaction = {
  id: "mac-approval",
  state: "pending",
  version: 1,
  createdAt: new Date(now).toISOString(),
  taskId: "task",
  turnId: "turn",
  agentId: "agent",
  threadId: "thread",
  type: "approval",
  urgency: "blocking",
  chain: [],
  items: [
    {
      id: "command",
      prompt: "Run on my Mac",
      choices: [
        { id: "allow_once" },
        { id: "reject_once" },
        { id: "allow_task_prefix", prefix: "pnpm test" },
      ],
    },
  ],
  context: {
    command: "pnpm test example",
    cwd: "/example/project",
    toolInput: { mac: "My Mac", stdin: "", timeoutSeconds: 60 },
    macExec: {
      v: 1,
      orgId: owner.orgId,
      userId: owner.userId,
      requestId: "command-request",
      taskId: "task",
      turnId: "turn",
      targetDeviceId: "mac",
      scope: "command",
      command: "pnpm test example",
      cwd: "/example/project",
      stdinHash: approvalStdinHash(),
      timeoutSeconds: 60,
    },
  },
};

it("signs the exact command the card displays for five minutes", () => {
  const details = macRequestDetails(request);
  expect(details).toMatchObject({ mac: "My Mac", canRun: true, stdin: "" });
  const answer = cloudAnswer(
    owner,
    request,
    { action: "accept", choice: "allow_once" },
    identity,
    now,
  );
  const signed = answer.signedApproval;
  expect(answer.by).toEqual({ kind: "human", id: owner.userId });
  if (!signed || !details) throw new Error("missing_signed_approval");
  expect(signed.payload).toEqual({
    ...details.draft,
    signerDeviceId: owner.deviceId,
    issuedAt: now,
    expiresAt: now + 300000,
  });
  expect(verifyApproval(toB64(identity.publicKey), signed, signed.payload, now)).toBe(true);
  expect(
    verifyApproval(
      toB64(identity.publicKey),
      signed,
      { ...signed.payload, command: "echo changed" },
      now,
    ),
  ).toBe(false);
  expect(verifyApproval(toB64(identity.publicKey), signed, signed.payload, now + 300000)).toBe(
    false,
  );
});

it("signs only the offered task prefix and keeps denial unsigned", () => {
  const signed = cloudAnswer(
    owner,
    request,
    { action: "accept", choice: "allow_task_prefix" },
    identity,
    now,
  ).signedApproval;
  expect(signed?.payload).toMatchObject({
    scope: "prefix",
    command: "pnpm test",
    taskId: "task",
    userId: "member",
    expiresAt: now + 300000,
  });
  expect(
    cloudAnswer(owner, request, { action: "decline", choice: "reject_once" }, undefined, now),
  ).not.toHaveProperty("signedApproval");
  expect(() =>
    cloudAnswer(
      owner,
      { ...request, items: [{ id: "command", prompt: "Run" }] },
      { action: "accept", choice: "allow_task_prefix" },
      identity,
      now,
    ),
  ).toThrow("cloud_answer_refused");
});

it("refuses mismatched authority, signing keys, execution options and hidden input", () => {
  const choice = { action: "accept", choice: "allow_once" } as const;
  expect(() => cloudAnswer({ ...owner, orgId: "other" }, request, choice, identity, now)).toThrow(
    "cloud_answer_refused",
  );
  expect(() => cloudAnswer({ ...owner, userId: "other" }, request, choice, identity, now)).toThrow(
    "cloud_answer_refused",
  );
  expect(() => cloudAnswer(owner, request, choice, createIdentity(), now)).toThrow(
    "cloud_answer_refused",
  );
  for (const context of [
    { ...request.context, command: "uname" },
    { ...request.context, cwd: "/other" },
    { ...request.context, toolInput: { stdin: "different" } },
    { ...request.context, toolInput: { timeoutSeconds: 601 } },
  ]) {
    expect(macRequestDetails({ ...request, context })).toBeUndefined();
    expect(() => cloudAnswer(owner, { ...request, context }, choice, identity, now)).toThrow(
      "cloud_answer_refused",
    );
  }
});

it("lists only valid pending Cloud interactions and honors the selected thread", () => {
  const snapshot = {
    seq: 1,
    counters: {},
    entities: {
      interaction: [
        request,
        { ...request, id: "other", threadId: "other-thread" },
        { ...request, id: "answered", state: "answered" },
        { id: "invalid", state: "pending", threadId: "thread" },
      ],
    },
  };
  expect(cloudRequests(snapshot, "thread")).toEqual([request]);
  expect(cloudRequests(snapshot).map((item) => item.id)).toEqual(["mac-approval", "other"]);
});
