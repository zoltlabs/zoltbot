import type { Grant } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { matchingGrant } from "./grants.js";

const grant: Grant = {
  id: "grant-a",
  holderAgentId: "profile-a",
  capability: "message",
  target: "profile-b",
  grantedBy: { kind: "human", id: "human" },
  createdAt: "2026-10-28T00:00:00.000Z",
};
const operation = {
  actorId: "profile-a",
  targetAgentId: "profile-b",
  targetProjectIds: ["project-b"],
  capability: "message" as const,
  targetAvailable: true,
};

it("requires explicit grants for profile communication and exact holder and capability matches", () => {
  expect(matchingGrant([], operation)).toBeUndefined();
  expect(matchingGrant([grant], operation)).toBe(grant.id);
  expect(matchingGrant([grant], { ...operation, actorId: "other" })).toBeUndefined();
  expect(matchingGrant([grant], { ...operation, capability: "control" })).toBeUndefined();
  expect(matchingGrant([grant], { ...operation, targetAgentId: "other" })).toBeUndefined();
});

it("matches project and wildcard grants only for the target's verified scopes", () => {
  const project = { ...grant, target: "project-b" };
  expect(matchingGrant([project], operation)).toBe(grant.id);
  expect(matchingGrant([project], { ...operation, targetProjectIds: ["foreign"] })).toBeUndefined();
  expect(matchingGrant([{ ...grant, target: "*" }], operation)).toBe(grant.id);
  expect(matchingGrant([{ ...grant, target: "profile-*" }], operation)).toBeUndefined();
});

it("takes revocation and unavailable targets into account on every call", () => {
  const grants = [{ ...grant }];
  expect(matchingGrant(grants, operation)).toBe(grant.id);
  grants[0] = { ...grant, revokedAt: "2026-10-28T00:00:01.000Z" };
  expect(matchingGrant(grants, operation)).toBeUndefined();
  expect(
    matchingGrant([{ ...grant, target: "*" }], { ...operation, targetAvailable: false }),
  ).toBeUndefined();
});
