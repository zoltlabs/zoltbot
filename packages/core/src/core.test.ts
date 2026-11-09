import { describe, expect, it } from "vitest";
import { applyEvents, type DomainState, handle, transition, transitions } from "./index.js";

const at = "2026-10-27T12:00:00.000Z";
const context = { commandId: "cmd", at, actor: { kind: "human" as const, id: "owner" } };
const profile = {
  id: "p",
  name: "Builder",
  avatar: "B",
  definitionId: "local",
  kind: "profile",
  permissionProfile: "workspace_write",
  instructions: "",
  hidden: false,
  archived: false,
};
const task = {
  id: "t",
  rootId: "t",
  title: "Build",
  brief: "Build carefully",
  acceptance: "Tests pass",
  expectedDeliverable: "Code",
  workspaceMode: "worktree",
  state: "queued",
  revision: 1,
  attempt: 1,
  maxAttempts: 1,
  reviewRequired: true,
  executionLocation: "local_isolated",
  createdBy: context.actor,
  createdAt: at,
  updatedAt: at,
};
const interaction = {
  id: "i",
  agentId: "p",
  threadId: "h",
  type: "question",
  version: 1,
  state: "pending",
  urgency: "blocking",
  items: [{ id: "q", prompt: "Which option?" }],
  chain: [],
  createdAt: at,
};
const expectedTransitions = {
  task: {
    queued: ["running", "cancelled"],
    running: ["blocked", "review", "completed", "failed", "cancelled"],
    blocked: ["running", "cancelled"],
    review: ["completed", "queued", "failed", "cancelled"],
    completed: [],
    failed: ["queued"],
    cancelled: [],
  },
  interaction: {
    pending: ["answered", "cancelled", "expired"],
    answered: [],
    cancelled: [],
    expired: [],
  },
  delivery: {
    queued: ["held", "delivering", "failed", "cancelled"],
    held: ["queued", "failed", "cancelled"],
    delivering: ["queued", "delivered", "failed", "cancelled"],
    delivered: [],
    failed: [],
    cancelled: [],
  },
  session: {
    starting: ["ready", "failed", "closed"],
    ready: ["running", "failed", "closed"],
    running: ["ready", "failed", "closed"],
    closed: [],
    failed: [],
  },
  turn: {
    running: ["completed", "failed", "interrupted"],
    completed: [],
    failed: [],
    interrupted: [],
  },
  workspace: { active: ["orphaned", "removed"], orphaned: ["active", "removed"], removed: [] },
} satisfies Record<string, Record<string, string[]>>;
describe("complete domain state transitions", () => {
  it("matches the specified lifecycle contract", () =>
    expect(transitions).toEqual(expectedTransitions));
  for (const [kind, table] of Object.entries(expectedTransitions)) {
    for (const [from, destinations] of Object.entries(table)) {
      for (const to of Object.keys(table)) {
        it(`${kind}: ${from} to ${to} is ${(destinations as string[]).includes(to) ? "legal" : "illegal"}`, () => {
          if ((destinations as string[]).includes(to))
            expect(transition(kind as keyof typeof transitions, from, to)).toBe(to);
          else
            expect(() => transition(kind as keyof typeof transitions, from, to)).toThrow(
              /invalid_transition/,
            );
        });
      }
    }
  }
});
describe("pure commands and projections", () => {
  it("creates profiles and projects deterministically without mutating inputs", () => {
    const state: DomainState = {};
    const first = handle(state, { type: "create", kind: "agent", value: profile }, context);
    expect(handle(state, { type: "create", kind: "agent", value: profile }, context)).toEqual(
      first,
    );
    expect(state).toEqual({});
    expect(applyEvents(state, first.events).agent).toEqual([profile]);
  });
  it("requires human confirmation before permission widening or grants", () => {
    const state = { agent: [profile] };
    expect(() =>
      handle(
        state,
        { type: "update", kind: "agent", id: "p", changes: { permissionProfile: "full_access" } },
        context,
      ),
    ).toThrow(/confirmation_required/);
    expect(
      handle(
        state,
        {
          type: "update",
          kind: "agent",
          id: "p",
          changes: { permissionProfile: "full_access" },
          confirmed: true,
        },
        context,
      ).events,
    ).toHaveLength(2);
    expect(() =>
      handle(
        state,
        {
          type: "update",
          kind: "agent",
          id: "p",
          changes: { permissionProfile: "full_access" },
          confirmed: true,
        },
        { ...context, actor: { kind: "agent", id: "p" } },
      ),
    ).toThrow(/confirmation_required/);
  });
  it("uses compare and set and lets exactly one interaction answer win", () => {
    const state = { interaction: [interaction] };
    const answer = {
      action: "accept" as const,
      by: context.actor,
      at,
      answers: { q: { other: "yes" } },
    };
    const result = handle(state, { type: "answer", id: "i", version: 1, answer }, context);
    const next = applyEvents(state, result.events);
    expect(next.interaction?.[0]).toMatchObject({ state: "answered", version: 2 });
    expect(() => handle(next, { type: "answer", id: "i", version: 1, answer }, context)).toThrow(
      /interaction_conflict/,
    );
    expect(() =>
      handle(
        { interaction: [{ ...interaction, state: "expired" }] },
        { type: "answer", id: "i", version: 1, answer },
        context,
      ),
    ).toThrow(/interaction_expired/);
  });
  it("fences stale task changes and increments revision on requested changes", () => {
    expect(() =>
      handle(
        { task: [task] },
        { type: "transition", kind: "task", id: "t", to: "running", revision: 0 },
        context,
      ),
    ).toThrow(/stale_revision/);
    const state = { task: [{ ...task, state: "review" }] };
    const events = handle(
      state,
      { type: "review", id: "t", revision: 1, decision: "changes", feedback: "Fix layout" },
      context,
    ).events;
    expect(applyEvents(state, events).task?.[0]).toMatchObject({
      revision: 2,
      state: "queued",
      brief: expect.stringContaining("Fix layout"),
    });
  });
  it("keeps bounded results and rejects duplicate entity creation", () => {
    expect(() =>
      handle({ agent: [profile] }, { type: "create", kind: "agent", value: profile }, context),
    ).toThrow(/already_exists/);
    expect(() =>
      handle(
        { task: [{ ...task, state: "running" }] },
        {
          type: "submitResult",
          id: "t",
          revision: 1,
          status: "done",
          summary: "x".repeat(2001),
          files: [],
        },
        context,
      ),
    ).toThrow(/result_too_large/);
  });
  it("never permits generic updates to bypass state or revision fences", () => {
    expect(() =>
      handle(
        { task: [task] },
        { type: "update", kind: "task", id: "t", changes: { state: "completed" } },
        context,
      ),
    ).toThrow(/protected_field/);
    expect(() =>
      handle(
        { interaction: [interaction] },
        { type: "update", kind: "interaction", id: "i", changes: { resolution: {} } },
        context,
      ),
    ).toThrow(/protected_field/);
  });
});

it("masks secret answers in every stored event and result", () => {
  const state = {
    interaction: [{ ...interaction, items: [{ id: "q", prompt: "Private value", secret: true }] }],
  };
  const outcome = handle(
    state,
    {
      type: "answer",
      id: "i",
      version: 1,
      answer: {
        action: "accept",
        answers: { q: { value: "seeded-private-value" } },
        by: context.actor,
        at,
      },
    },
    context,
  );
  expect(JSON.stringify(outcome)).not.toContain("seeded-private-value");
  expect(JSON.stringify(outcome)).toContain("[secret]");
});

it("requires a result before a running task can be completed", () => {
  expect(() =>
    handle(
      { task: [{ ...task, state: "running" }] },
      { type: "transition", kind: "task", id: "t", to: "completed", revision: 1 },
      context,
    ),
  ).toThrow(/result_required/);
});
