import type { DomainState } from "@zoltbot/core";
import type { KnowledgeItem, Scope } from "@zoltbot/protocol";
import { describe, expect, it } from "vitest";
import { userScope } from "./commands.js";
import {
  defaultWriteCaps,
  evaluateWrite,
  type KnowledgeWriteInput,
  type KnowledgeWriteSession,
} from "./policy.js";

const at = "2026-11-06T00:00:00Z";
const person = { kind: "human" as const, id: "local-owner" };
const agent = { kind: "agent" as const, id: "claude" };
const project: Scope = { type: "project", id: "p" };
const task: Scope = { type: "task", id: "t" };
const evidence = [{ kind: "task" as const, ref: "t" }];
function item(id: string, changes: Partial<KnowledgeItem> = {}): KnowledgeItem {
  return {
    id,
    scope: project,
    kind: "lesson",
    title: id,
    body: `${id} body text`,
    tags: [],
    sources: [],
    owner: person,
    verification: "human",
    writer: person,
    status: "active",
    revision: 1,
    createdAt: at,
    updatedAt: at,
    ...changes,
  };
}
const projectRow = (id: string) => ({
  id,
  name: id,
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
});
const fixtures = {
  humanUnits: item("units", { kind: "constraint", key: "units", body: "Use grams for meals." }),
  agentLesson: item("cache", {
    title: "Warm the cache",
    body: "Warm the build cache before tests.",
    verification: "unverified",
    writer: agent,
    owner: agent,
    sources: [{ kind: "task", ref: "other-task", sessionId: "other-session" }],
  }),
  ownLesson: item("own", {
    title: "Own lesson",
    body: "Written in this task.",
    verification: "unverified",
    writer: agent,
    owner: agent,
    sources: [{ kind: "task", ref: "t", sessionId: "s" }],
  }),
  elsewhere: item("elsewhere", { scope: { type: "project", id: "q" } }),
};
const baseState = (extra: Partial<DomainState> = {}): DomainState =>
  ({
    project: [projectRow("p"), projectRow("q")],
    task: [{ id: "t", projectId: "p", node: project }],
    knowledge: Object.values(fixtures),
    settings: [],
    knowledgeProposal: [],
    ...extra,
  }) as DomainState;
const session = (changes: Partial<KnowledgeWriteSession> = {}): KnowledgeWriteSession => ({
  sessionId: "s",
  agentId: "claude",
  taskId: "t",
  threadId: "t:thread",
  node: task,
  tainted: false,
  grants: [],
  written: { applied: 0, proposed: 0 },
  caps: defaultWriteCaps,
  secretDetected: false,
  ...changes,
});
const write = (changes: Partial<KnowledgeWriteInput> = {}): KnowledgeWriteInput => ({
  op: "create",
  scope: "project",
  kind: "lesson",
  title: "Pin node versions",
  body: "Use the version in .nvmrc for every script.",
  evidence,
  reason: "Seen in CI logs",
  ...changes,
});
const full = { applied: 5, proposed: 5 };

// Each row: [name, session, input, expected outcome, expected reason, state?]
const rows: [
  string,
  Partial<KnowledgeWriteSession>,
  Partial<KnowledgeWriteInput>,
  string,
  string,
  Partial<DomainState>?,
][] = [
  ["1 secret", { secretDetected: true }, {}, "rejected", "secret_detected"],
  [
    "1 secret beats a full cap",
    { secretDetected: true, written: full },
    {},
    "rejected",
    "secret_detected",
  ],
  [
    "1 secret beats user scope",
    { secretDetected: true },
    { scope: "user" },
    "rejected",
    "secret_detected",
  ],
  ["2 both buckets full", { written: full }, {}, "rejected", "cap_reached"],
  ["2 cap beats missing evidence", { written: full }, { evidence: [] }, "rejected", "cap_reached"],
  [
    "2 applied bucket full for an applied write",
    { written: { applied: 5, proposed: 0 } },
    {},
    "rejected",
    "cap_reached",
  ],
  [
    "2 applied bucket full does not block a proposal",
    { written: { applied: 5, proposed: 0 } },
    { scope: "user" },
    "proposed",
    "user_scope",
  ],
  [
    "2 proposed bucket full",
    { written: { applied: 0, proposed: 5 } },
    { scope: "user" },
    "rejected",
    "cap_reached",
  ],
  ["3 lesson without evidence", {}, { evidence: [] }, "rejected", "no_evidence"],
  [
    "3 decision without evidence",
    {},
    { kind: "decision", scope: "here", evidence: [] },
    "rejected",
    "no_evidence",
  ],
  ["3 goal needs no evidence", {}, { kind: "goal", evidence: [] }, "applied", "low_risk"],
  [
    "3 confirm needs evidence",
    {},
    { op: "confirm", id: "cache", expectedRevision: 1, evidence: [] },
    "rejected",
    "no_evidence",
  ],
  [
    "revise of an unknown item",
    {},
    { op: "revise", id: "missing", expectedRevision: 1 },
    "rejected",
    "scope_denied",
  ],
  [
    "revise outside the chain",
    {},
    { op: "revise", id: "elsewhere", expectedRevision: 1 },
    "rejected",
    "scope_denied",
  ],
  [
    "stale revision",
    {},
    { op: "revise", id: "cache", expectedRevision: 3 },
    "rejected",
    "stale_revision",
  ],
  [
    "not durable above own node",
    {},
    { title: "Status", body: "Currently fixing the login test." },
    "rejected",
    "not_durable",
  ],
  [
    "progress at own node is allowed",
    {},
    { scope: "here", title: "Status", body: "Currently fixing the login test." },
    "applied",
    "own_node",
  ],
  ["4 duplicate of an unverified item", {}, { title: "Warm the cache" }, "merged", "duplicate"],
  [
    "4 duplicate of a human item",
    {},
    { kind: "constraint", title: "Units", body: "Use grams for meals." },
    "merged",
    "duplicate",
  ],
  [
    "4 duplicate beats user scope",
    {},
    { scope: "user", title: "Warm the cache" },
    "proposed",
    "user_scope",
  ],
  [
    "4 duplicate beats taint",
    { tainted: true },
    { title: "Warm the cache" },
    "merged",
    "duplicate",
  ],
  ["5 user scope", {}, { scope: "user", kind: "preference" }, "proposed", "user_scope"],
  ["5 tainted plus user scope", { tainted: true }, { scope: "user" }, "proposed", "user_scope"],
  [
    "5 grants never cover the user scope",
    { grants: [project, userScope] },
    { scope: "user", kind: "decision" },
    "proposed",
    "user_scope",
  ],
  [
    "6 revise a human item",
    {},
    { op: "revise", id: "units", expectedRevision: 1, kind: "constraint" },
    "proposed",
    "protected_item",
  ],
  [
    "6 revise a confirmed item",
    {},
    { op: "revise", id: "units", expectedRevision: 1, kind: "constraint" },
    "proposed",
    "protected_item",
    { knowledge: [{ ...fixtures.humanUnits, verification: "confirmed" }] },
  ],
  [
    "6 same key as a human item",
    {},
    {
      key: "units",
      kind: "constraint",
      title: "Unit choice",
      body: "Always use ounces in reports.",
    },
    "proposed",
    "protected_item",
  ],
  [
    "6 opposite polarity to a human item",
    {},
    { kind: "lesson", title: "Grams meals", body: "Never use grams for meals." },
    "proposed",
    "protected_item",
  ],
  [
    "6 revise beats taint",
    { tainted: true },
    { op: "revise", id: "units", expectedRevision: 1, kind: "constraint" },
    "proposed",
    "protected_item",
  ],
  ["7 tainted above own node", { tainted: true }, {}, "proposed", "tainted"],
  ["7 tainted at own node", { tainted: true }, { scope: "here" }, "applied", "own_node"],
  [
    "7 tainted revise of an unverified project item",
    { tainted: true },
    { op: "revise", id: "cache", expectedRevision: 1 },
    "proposed",
    "tainted",
  ],
  [
    "7 taint beats a grant",
    { tainted: true, grants: [project] },
    { kind: "decision" },
    "proposed",
    "tainted",
  ],
  ["8 decision above own node", {}, { kind: "decision" }, "proposed", "grant_required"],
  [
    "8 constraint above own node",
    {},
    { kind: "constraint", title: "No force push", body: "Do not force push main." },
    "proposed",
    "grant_required",
  ],
  [
    "8 requirement with a grant",
    { grants: [project] },
    { kind: "requirement" },
    "applied",
    "granted",
  ],
  [
    "8 grant on another project",
    { grants: [{ type: "project", id: "q" }] },
    { kind: "decision" },
    "proposed",
    "grant_required",
  ],
  ["9 decision at own node", {}, { scope: "here", kind: "decision" }, "applied", "own_node"],
  ["9 lesson at project", {}, {}, "applied", "low_risk"],
  [
    "9 open question at project",
    {},
    { kind: "open_question", evidence: [] },
    "applied",
    "low_risk",
  ],
  [
    "9 revise own unverified item",
    {},
    { op: "revise", id: "own", expectedRevision: 1 },
    "applied",
    "low_risk",
  ],
  [
    "confirm by an independent session",
    {},
    {
      op: "confirm",
      id: "cache",
      expectedRevision: 1,
      title: "Warm the cache",
      body: "Warm the build cache before tests.",
    },
    "applied",
    "low_risk",
  ],
  [
    "confirm by the writing task",
    {},
    { op: "confirm", id: "own", expectedRevision: 1 },
    "rejected",
    "scope_denied",
  ],
  [
    "confirm from a tainted session",
    { tainted: true },
    { op: "confirm", id: "cache", expectedRevision: 1 },
    "proposed",
    "tainted",
  ],
  [
    "previously rejected write",
    {},
    {},
    "rejected",
    "previously_rejected",
    { knowledgeProposal: [] },
  ],
];

describe("file 12 section 6.2 write policy", () => {
  it.each(rows)("%s", (_name, sessionChanges, inputChanges, outcome, reason, stateChanges) => {
    let state = baseState(stateChanges);
    const input = write(inputChanges);
    if (reason === "previously_rejected") {
      const first = evaluateWrite(state, session(), input);
      expect(first.outcome).toBe("applied");
      if (first.outcome === "rejected") return;
      state = baseState({
        knowledgeProposal: [{ id: "old", state: "rejected", fingerprint: first.fingerprint }],
      });
    }
    const decision = evaluateWrite(state, session(sessionChanges), input);
    expect([decision.outcome, decision.reason]).toEqual([outcome, reason]);
  });
  it("reports the target, the existing item and conflicts", () => {
    const merged = evaluateWrite(baseState(), session(), write({ title: "Warm the cache" }));
    expect(merged).toMatchObject({ outcome: "merged", item: { id: "cache" }, target: project });
    const conflict = evaluateWrite(
      baseState(),
      session(),
      write({ key: "units", kind: "constraint", title: "Unit choice", body: "Always ounces." }),
    );
    expect(conflict).toMatchObject({ outcome: "proposed", conflicts: ["units"] });
    expect(evaluateWrite(baseState(), session(), write({ scope: "here" }))).toMatchObject({
      target: task,
    });
  });
});
