import { randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import type { InteractionAnswer } from "./interactions.js";
import { assertNoPrivateValue, publicAnswerData } from "./private-values.js";

it("checks signed approval metadata for known private values before persistence", () => {
  const value = randomBytes(32).toString("base64url");
  const answer: InteractionAnswer = {
    action: "accept",
    choice: "allow_once",
    by: { kind: "human", id: "member" },
    at: "2026-11-12T00:00:00Z",
    signedApproval: {
      payload: {
        v: 1,
        orgId: "org",
        userId: "member",
        signerDeviceId: "phone",
        requestId: "request",
        taskId: "task",
        turnId: "turn",
        targetDeviceId: "mac",
        scope: "command",
        command: `printf ${value}`,
        cwd: "/work",
        stdinHash: "A".repeat(43),
        timeoutSeconds: 600,
        issuedAt: 1,
        expiresAt: 300001,
      },
      signature: "A".repeat(86),
    },
  };
  expect(() => assertNoPrivateValue(publicAnswerData({ items: [] }, answer), [value])).toThrow(
    "private_value_requires_secure_field",
  );
  delete answer.signedApproval;
  expect(() =>
    assertNoPrivateValue(publicAnswerData({ items: [] }, answer), [value]),
  ).not.toThrow();
});
