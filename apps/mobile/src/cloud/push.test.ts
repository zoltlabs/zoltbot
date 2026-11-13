import { expect, it } from "vitest";
import { apnsPayload } from "../../../../services/relay/src/push.js";
import { pushActions, pushResponse, readPushTarget } from "../data/push.js";

const cloud = { kind: "cloud", orgId: "personal", notificationId: "a".repeat(64) } as const;
it("round-trips an org-bound content-free notice without Local routing or approval actions", () => {
  const payload = apnsPayload("needs_you", 1, undefined, "thread:one", cloud);
  const target = readPushTarget({ data: payload });
  expect(pushResponse(target, "default")).toEqual({
    kind: "open_cloud",
    orgId: "personal",
    threadId: "thread:one",
    notificationId: cloud.notificationId,
  });
  for (const action of Object.values(pushActions))
    expect(pushResponse(target, action)).toEqual({ kind: "none" });
  expect("category" in payload.aps).toBe(false);
  expect("interactionId" in payload).toBe(false);
});
it("quarantines malformed or conflicting scopes before Local actions or navigation", () => {
  for (const scope of [
    null,
    {},
    { ...cloud, orgId: "private prose" },
    { ...cloud, kind: "other" },
    { ...cloud, command: "uname" },
  ]) {
    const target = readPushTarget({
      categoryIdentifier: "approval",
      data: { scope, threadId: "local-thread", interactionId: "local-interaction", version: 1 },
    });
    for (const action of ["default", ...Object.values(pushActions)])
      expect(pushResponse(target, action)).toEqual({ kind: "none" });
  }
  const target = readPushTarget({
    data: {
      scope: cloud,
      body: { scope: { ...cloud, orgId: "other-org" }, threadId: "thread:one" },
    },
  });
  expect(pushResponse(target, "default")).toEqual({ kind: "none" });
});
it("accepts equivalent nested scopes independent of property order", () => {
  const target = readPushTarget({
    data: {
      scope: cloud,
      body: {
        scope: { notificationId: cloud.notificationId, orgId: cloud.orgId, kind: cloud.kind },
        threadId: "thread:one",
      },
    },
  });
  expect(pushResponse(target, "default").kind).toBe("open_cloud");
});
it("keeps existing paired-Mac notification approvals and thread routing", () => {
  const target = readPushTarget({
    categoryIdentifier: "approval",
    data: { threadId: "thread", interactionId: "request", version: 3 },
  });
  expect(pushResponse(target, "default")).toEqual({ kind: "open", threadId: "thread" });
  expect(pushResponse(target, pushActions.allow)).toEqual({
    kind: "answer",
    id: "request",
    version: 3,
    threadId: "thread",
    answer: { action: "accept", choice: "allow_once" },
  });
});
it("refuses a manually supplied Cloud target's unsigned action even without its scope marker", () => {
  expect(
    pushResponse(
      { category: "approval", cloud, threadId: "thread", interactionId: "request", version: 1 },
      pushActions.allow,
    ),
  ).toEqual({ kind: "none" });
});
