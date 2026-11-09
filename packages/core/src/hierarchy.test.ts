import { expect, it } from "vitest";
import { createDirection, createScopedChat, scopeLineage } from "./hierarchy.js";
import { applyEvents, type DomainState } from "./projectors.js";

const at = "2026-10-29T00:00:00Z";
const context = { commandId: "scope", at, actor: { kind: "human" as const, id: "owner" } };
const project = {
  id: "zolt",
  name: "Zolt",
  goal: "Help people",
  instructions: "Keep user data private",
  constraints: "Local first",
  roots: [],
  hierarchyDepth: 3,
  tags: [],
  requireCodeReview: false,
  skipFinalGateWhenReviewed: false,
  archived: false,
  createdAt: at,
};
const product = {
  id: "product",
  projectId: "zolt",
  name: "Zolt Product",
  label: "Direction",
  goal: "Build the product",
  instructions: "Verify changes",
  depth: 1,
  archived: false,
  createdAt: at,
};
const food = {
  ...product,
  id: "food",
  parentId: "product",
  name: "Food logging",
  goal: "Reliable logging",
  instructions: "Preserve nutrient accuracy",
  depth: 2,
};
const profile = {
  id: "claude",
  name: "Claude",
  avatar: "C",
  definitionId: "claude",
  kind: "profile",
  permissionProfile: "read_only",
  instructions: "Be clear",
  hidden: false,
  archived: false,
};
function fixture(): DomainState {
  return { project: [project], subproject: [product, food], agent: [profile] };
}
function chat(id: string, kind: "manager" | "side" = "side") {
  return {
    id,
    agentId: "claude",
    projectId: "zolt",
    node: { type: "subproject", id: "food" },
    kind,
    title: id,
    titleSource: "human",
    pinned: false,
    archived: false,
    createdAt: at,
    lastActivityAt: at,
  };
}
it("resolves workspace and direction ancestry without crossing projects or accepting cycles", () => {
  const state = fixture();
  const result = scopeLineage(state, { type: "subproject", id: "food" });
  expect(result.project.name).toBe("Zolt");
  expect(result.directions.map((row) => row.name)).toEqual(["Zolt Product", "Food logging"]);
  expect(() =>
    scopeLineage(
      { ...state, subproject: [product, { ...food, projectId: "another" }] },
      { type: "subproject", id: "food" },
    ),
  ).toThrow("scope_unavailable");
  expect(() =>
    scopeLineage(
      { ...state, subproject: [{ ...product, parentId: "food" }, food] },
      { type: "subproject", id: "food" },
    ),
  ).toThrow("scope_unavailable");
});
it("creates directions at the right depth and raises a flat workspace only as far as requested", () => {
  const state = { project: [{ ...project, hierarchyDepth: 0 }] };
  const output = createDirection(state, product, context);
  const updated = applyEvents(state, output.events);
  expect(updated.project?.[0]?.hierarchyDepth).toBe(1);
  expect(updated.subproject?.[0]).toEqual(product);
  expect(() => createDirection(fixture(), { ...food, id: "invalid", depth: 1 }, context)).toThrow(
    "invalid_hierarchy",
  );
});
it("requires confirmed human manager assignment, keeps one active manager per scope and permits independent sub-chats", () => {
  const state = fixture(),
    value = chat("manager", "manager");
  expect(() => createScopedChat(state, value, context)).toThrow("confirmation_required");
  const output = createScopedChat(state, value, context, true);
  const updated = applyEvents(state, output.events);
  expect(
    output.events.some(
      (event) =>
        event.aggregateType === "audit" &&
        (event.payload as { action: string }).action === "manager.assign",
    ),
  ).toBe(true);
  expect(() => createScopedChat(updated, chat("another", "manager"), context, true)).toThrow(
    "manager_already_assigned",
  );
  const one = createScopedChat(updated, chat("nutrients"), { ...context, commandId: "one" });
  const two = createScopedChat(applyEvents(updated, one.events), chat("meal-search"), {
    ...context,
    commandId: "two",
  });
  expect(two.result.id).toBe("meal-search");
  expect(() => createScopedChat(state, { ...value, projectId: "wrong" }, context, true)).toThrow(
    "scope_project_mismatch",
  );
});
