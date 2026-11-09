import { expect, it } from "vitest";
import { delegateChat } from "./delegation.js";
import { applyEvents } from "./projectors.js";
import { teamHopLimit } from "./team.js";

const at = "2026-10-29T12:00:00Z";
function fixture() {
  return {
    agent: [
      { id: "profile", definitionId: "claude", archived: false, permissionProfile: "read_only" },
    ],
    project: [
      {
        id: "zolt",
        name: "Zolt",
        goal: "",
        instructions: "",
        constraints: "",
        roots: [],
        hierarchyDepth: 3,
        tags: [],
        requireCodeReview: false,
        skipFinalGateWhenReviewed: false,
        archived: false,
        createdAt: at,
      },
    ],
    thread: [
      {
        id: "manager",
        agentId: "profile",
        projectId: "zolt",
        node: { type: "project", id: "zolt" },
        kind: "manager",
        title: "Manager",
        titleSource: "human",
        pinned: false,
        archived: false,
        createdAt: at,
        lastActivityAt: at,
      },
    ],
    session: [{ id: "session", threadId: "manager", state: "running" }],
    turn: [{ id: "turn", sessionId: "session", threadId: "manager", status: "running" }],
  };
}
const actor = { agentId: "profile", threadId: "manager", sessionId: "session", turnId: "turn" };
const context = { commandId: "delegate", at, actor: { kind: "agent" as const, id: "profile" } };
it("creates an attributed child brief in exactly the manager scope and prevents recursive delegation", () => {
  const initial = fixture();
  const out = delegateChat(
    initial,
    actor,
    { title: "Investigate", brief: "Check reliability", profileId: "profile" },
    "child",
    context,
  );
  const state = applyEvents(initial, out.events);
  expect(state.thread?.find((row) => row.id === "child")).toMatchObject({
    kind: "side",
    node: initial.thread[0]?.node,
  });
  expect(state.item?.[0]?.body).toMatchObject({
    origin: "agent",
    sourceMessageId: "child:brief",
    queueState: "queued",
  });
  expect(state.message?.[0]).toMatchObject({
    from: { kind: "agent", id: "profile" },
    origin: "agent",
    hops: 1,
    ttlHops: teamHopLimit,
  });
  expect(() =>
    delegateChat(
      state,
      { ...actor, threadId: "child" },
      { title: "Loop", brief: "Again", profileId: "profile" },
      "next",
      context,
    ),
  ).toThrow("manager_scope_required");
});
it("rejects inactive turns, unavailable profiles and excessive briefs before creating a child", () => {
  const state = fixture();
  for (const [identity, brief, profileId] of [
    [{ ...actor, turnId: "ended" }, "Work", "profile"],
    [actor, "x".repeat(2001), "profile"],
    [actor, "Work", "missing"],
  ] as const)
    expect(() =>
      delegateChat(state, identity, { title: "Work", brief, profileId }, "child", context),
    ).toThrow();
  expect(state.thread).toHaveLength(1);
});

it("refuses a stronger child permission profile, including when the manager preset changed after its native session began", () => {
  const state = fixture();
  const stronger = {
    id: "stronger",
    definitionId: "codex",
    archived: false,
    permissionProfile: "full_access",
  };
  const initial = { ...state, agent: [...state.agent, stronger] };
  expect(() =>
    delegateChat(
      initial,
      actor,
      { title: "Write", brief: "Edit", profileId: "stronger" },
      "child",
      context,
    ),
  ).toThrow("delegation_permission_widening");
  const edited = {
    ...initial,
    agent: initial.agent.map((row) => ({ ...row, permissionProfile: "full_access" })),
    settings: [
      {
        key: "runtime.configuration.session",
        value: { profile: { permissionProfile: "read_only" } },
      },
    ],
  };
  expect(() =>
    delegateChat(
      edited,
      actor,
      { title: "Write", brief: "Edit", profileId: "stronger" },
      "child",
      context,
    ),
  ).toThrow("delegation_permission_widening");
});
