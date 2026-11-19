// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { ConversationMessage } from "../shared/ipc";
import type { Row, Snapshot } from "./daemon-client";
import {
  isStaffApproval,
  parseStaffAction,
  runStaffAction,
  staffProject,
  toStaffOverview,
  withStaffCards,
} from "./staff-view";

const at = (minute: number) => `2026-11-19T10:${String(minute).padStart(2, "0")}:00.000Z`;
const snapshot = (entities: Record<string, Row[]>): Snapshot => ({
  seq: 1,
  entities,
  counters: {},
});

const approval = (id: string, preview: Row, extra: Row = {}): Row => ({
  id,
  threadId: "mgr",
  type: "approval",
  state: "pending",
  version: 2,
  title: `Change ${String(preview.name)}`,
  createdAt: at(2),
  context: {
    toolInput: {
      staffChange: {
        actor: { agentId: "a", threadId: "mgr" },
        request: preview.kind === "add" ? { kind: "add" } : { kind: preview.kind, threadId: "ivy" },
        id: "ivy",
        preview,
      },
    },
  },
  ...extra,
});

const ADD = approval(
  "staff-approval-add",
  {
    kind: "add",
    projectId: "launch",
    name: "Nova",
    teamName: "Design",
    requestedBy: { threadId: "mgr", name: "Robin" },
    fields: [{ label: "Role", after: "Draws icons" }],
    allowanceOffer: { max: 2, models: [], folders: [] },
  },
  { title: "Add Nova to Design" },
);
const ARCHIVE = approval("staff-approval-archive", {
  kind: "archive",
  projectId: "launch",
  name: "Ivy",
  teamName: "Design",
  fields: [],
  moves: [{ title: "Icon set", to: "Robin" }],
  running: 1,
});

const entities = (): Record<string, Row[]> => ({
  thread: [
    { id: "ceo", projectId: "launch", kind: "manager", title: "Avery", agentId: "p-ceo" },
    {
      id: "mgr",
      projectId: "launch",
      kind: "manager",
      title: "Robin",
      agentId: "p-mgr",
      node: { type: "subproject", id: "design" },
    },
    {
      id: "ivy",
      projectId: "launch",
      kind: "side",
      title: "Ivy",
      agentId: "p-ivy",
      node: { type: "subproject", id: "design" },
      archiveWhenIdle: true,
    },
    { id: "gone", projectId: "launch", kind: "side", title: "Gone", archived: true },
  ],
  agent: [
    {
      id: "p-ivy",
      name: "Ivy",
      model: "sonnet",
      roleText: "Draws icons",
      instructions: "Be brief",
    },
  ],
  subproject: [{ id: "design", name: "Design", projectId: "launch" }],
  project: [{ id: "launch", name: "Launch" }],
  interaction: [
    ADD,
    ARCHIVE,
    { id: "other", threadId: "mgr", type: "approval", state: "pending", createdAt: at(3) },
  ],
  settings: [
    {
      key: "staff.allowance.mgr",
      value: { threadId: "mgr", projectId: "launch", max: 3, used: 1 },
    },
  ],
});

describe("staff view", () => {
  it("turns staff approvals into cards in the chat that asked", () => {
    const messages: ConversationMessage[] = [
      { id: "m1", author: "user", text: "hire", createdAt: at(1), status: "completed" },
      { id: "m2", author: "assistant", text: "ok", createdAt: at(5), status: "completed" },
    ] as ConversationMessage[];
    const result = withStaffCards(snapshot(entities()), "mgr", messages);
    expect(result.map((message) => message.id)).toEqual([
      "m1",
      "card:staff:staff-approval-add",
      "card:staff:staff-approval-archive",
      "m2",
    ]);
    expect(result[1]?.card).toMatchObject({
      kind: "staff",
      action: "add",
      state: "pending",
      title: "Add Nova to Design",
      requestedBy: "Robin",
      allowance: 2,
      fields: [{ label: "Role", after: "Draws icons" }],
    });
    expect(result[2]?.card).toMatchObject({
      action: "archive",
      moves: [{ title: "Icon set", to: "Robin" }],
      running: 1,
      allowance: null,
    });
    expect(withStaffCards(snapshot(entities()), "ivy", messages)).toBe(messages);
  });

  it("marks answered cards approved or declined", () => {
    const rows = entities();
    rows.interaction = [
      { ...ADD, state: "answered", resolution: { action: "accept" } },
      { ...ARCHIVE, state: "answered", resolution: { action: "decline" } },
    ];
    const cards = withStaffCards(snapshot(rows), "mgr", []).map((message) => message.card);
    expect(cards.map((card) => card && "state" in card && card.state)).toEqual([
      "approved",
      "declined",
    ]);
  });

  it("lists pending approvals and the people of a project", () => {
    const overview = toStaffOverview(snapshot(entities()), "launch");
    expect(overview.approvals.map((card) => card.requestId)).toEqual([
      "staff-approval-add",
      "staff-approval-archive",
    ]);
    expect(overview.people.map((person) => person.botId)).toEqual(["ceo", "mgr", "ivy"]);
    expect(overview.people[0]?.role).toBe("ceo");
    expect(overview.people[1]).toMatchObject({ role: "manager", allowance: { max: 3, used: 1 } });
    expect(overview.people[2]).toMatchObject({
      role: "employee",
      teamName: "Design",
      model: "sonnet",
      instructions: "Be brief",
      archiving: true,
      pending: "archive",
    });
    expect(toStaffOverview(snapshot(entities()), "other").approvals).toEqual([]);
    expect(toStaffOverview(snapshot(entities()), null).people).toEqual([]);
  });

  it("finds the project a staff row changes", () => {
    expect(isStaffApproval(ADD)).toBe(true);
    expect(isStaffApproval({ id: "other" })).toBe(false);
    expect(staffProject("interaction", ADD)).toBe("launch");
    expect(staffProject("interaction", { id: "other" })).toBeUndefined();
    expect(
      staffProject("settings", { key: "staff.allowance.mgr", value: { projectId: "launch" } }),
    ).toBe("launch");
    expect(staffProject("settings", { key: "team.wait.mgr", value: {} })).toBeUndefined();
  });

  it("validates actions from the renderer", () => {
    expect(parseStaffAction({ action: "approve", requestId: "r", grantAllowance: "yes" })).toEqual({
      action: "approve",
      requestId: "r",
      grantAllowance: false,
    });
    expect(parseStaffAction({ action: "archive", threadId: "ivy", moveTo: "mgr" })).toEqual({
      action: "archive",
      threadId: "ivy",
      moveTo: "mgr",
    });
    expect(() => parseStaffAction({ action: "allowance", threadId: "mgr", max: 21 })).toThrow();
    expect(() => parseStaffAction({ action: "change", threadId: "" })).toThrow();
    expect(() => parseStaffAction({ action: "change", threadId: "x", name: 3 })).toThrow();
    expect(() => parseStaffAction({ action: "hire" })).toThrow();
  });

  it("answers approvals as the owner and sends direct changes", async () => {
    const call = vi.fn().mockResolvedValue({});
    const interactions = entities().interaction ?? [];
    await runStaffAction(call, interactions, {
      action: "approve",
      requestId: "staff-approval-add",
      grantAllowance: true,
    });
    expect(call).toHaveBeenLastCalledWith(
      "interaction.answer",
      expect.objectContaining({
        id: "staff-approval-add",
        version: 2,
        answer: expect.objectContaining({
          action: "accept",
          choice: "allow_once",
          answers: { change: { options: ["allowance"] } },
          by: { kind: "human", id: "local-owner" },
        }),
      }),
      "shell:staff:staff-approval-add:approve",
    );
    await runStaffAction(call, interactions, { action: "archive", threadId: "ivy", moveTo: "mgr" });
    expect(call).toHaveBeenLastCalledWith(
      "staff.apply",
      { request: { kind: "archive", threadId: "ivy", moveTo: "mgr" } },
      expect.stringMatching(/^shell:staff:archive:ivy:/),
    );
    await runStaffAction(call, interactions, { action: "allowance", threadId: "mgr", max: 4 });
    expect(call).toHaveBeenLastCalledWith(
      "staff.allowance",
      { threadId: "mgr", max: 4 },
      expect.stringMatching(/^shell:staff-allowance:mgr:4:/),
    );
    await expect(
      runStaffAction(call, [{ ...ADD, state: "answered" }], {
        action: "decline",
        requestId: "staff-approval-add",
      }),
    ).rejects.toThrow("already answered");
  });
});
