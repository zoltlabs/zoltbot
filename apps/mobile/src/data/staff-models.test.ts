import { describe, expect, it } from "vitest";
import {
  accountViews,
  chatAccount,
  missingFreeModels,
  moveEntry,
  orderFor,
  runningLimit,
  switchAnswer,
  switchDetail,
  switchNoteText,
  switchQuestion,
  toFreeModels,
  toOrders,
} from "./backup-models.js";
import {
  allowanceChange,
  approveLabel,
  askTitle,
  cardFields,
  isStaffApproval,
  staffAnswer,
  toStaffCard,
} from "./staff.js";
import { transcript } from "./timeline.js";
import type { Row, Snapshot } from "./transport.js";
import { needsYou, projectSummaries } from "./view.js";

const snapshot = (entities: Record<string, Row[]>): Snapshot =>
  ({ seq: 1, entities, counters: {} }) as unknown as Snapshot;
const clock = (iso: string) => `${new Date(iso).getUTCHours() % 12 || 12}:00 PM`;

const staffApproval = (extra: Row = {}): Row => ({
  id: "staff-approval-juno",
  threadId: "mira",
  agentId: "lead",
  type: "approval",
  state: "pending",
  version: 1,
  title: "Add Juno to Web",
  createdAt: "2026-11-19T15:05:00.000Z",
  items: [{ id: "change", prompt: "Add Juno to Web" }],
  context: {
    toolInput: {
      staffChange: {
        request: { kind: "add", name: "Juno", role: "QA engineer" },
        preview: {
          kind: "add",
          projectId: "web",
          name: "Juno",
          teamName: "Web",
          requestedBy: { threadId: "mira", name: "Mira" },
          fields: [
            { label: "Name", after: "Juno" },
            { label: "Role", after: "QA engineer" },
            { label: "Model", after: "Sonnet" },
            { label: "Can edit", after: "apps/web/tests" },
            { label: "Reports to", after: "Mira" },
            { label: "First task", after: "Write EU checkout tests" },
          ],
          allowanceOffer: { max: 2, models: ["Sonnet"], folders: ["apps/web/tests"] },
        },
      },
    },
  },
  ...extra,
});

describe("staff approvals", () => {
  it("reads the card from the approval's stored preview", () => {
    const card = toStaffCard(staffApproval());
    expect(card).toMatchObject({ action: "add", state: "pending", requestedBy: "Mira" });
    if (!card) return;
    expect(askTitle(card)).toBe("Add Juno to Web?");
    expect(approveLabel(card)).toBe("Add Juno");
    expect(cardFields(card).map((row) => row.label)).toEqual([
      "Role",
      "Reports to",
      "Model",
      "Can edit",
      "First task",
    ]);
    expect(isStaffApproval({ id: "other", context: {} })).toBe(false);
  });

  it("answers with the allowance option only when the box is ticked", () => {
    expect(staffAnswer(true, false)).toEqual({ action: "accept", choice: "allow_once" });
    expect(staffAnswer(true, true)).toEqual({
      action: "accept",
      choice: "allow_once",
      answers: { change: { options: ["allowance"] } },
    });
    expect(staffAnswer(false, true)).toEqual({ action: "decline", choice: "reject_once" });
  });

  it("sets the allowance again only when the number changed", () => {
    const card = toStaffCard(staffApproval());
    if (!card) throw new Error("no card");
    expect(allowanceChange(card, true, 2)).toBeUndefined();
    expect(allowanceChange(card, false, 5)).toBeUndefined();
    expect(allowanceChange(card, true, 5)).toEqual({
      threadId: "mira",
      max: 5,
      models: ["Sonnet"],
      folders: ["apps/web/tests"],
    });
  });

  it("shows as a card in the manager's chat and counts as needing you", () => {
    const data = snapshot({
      project: [{ id: "web", name: "Web", archived: false }],
      thread: [{ id: "mira", title: "Mira", agentId: "lead", projectId: "web", archived: false }],
      item: [],
      interaction: [staffApproval()],
    });
    expect(transcript(data, "mira").map((row) => row.staffId)).toEqual(["staff-approval-juno"]);
    expect(needsYou(data).map((item) => item.id)).toEqual(["staff-approval-juno"]);
    expect(projectSummaries(data)[0]?.counts.needsYou).toBe(1);
  });

  it("turns the approval's own interaction item into the card", () => {
    const data = snapshot({
      thread: [{ id: "mira", title: "Mira", agentId: "lead", archived: false }],
      item: [
        {
          id: "ask",
          threadId: "mira",
          turnId: "turn-1",
          seq: 1,
          kind: "interaction",
          body: { interactionId: "staff-approval-juno" },
          createdAt: "2026-11-19T15:05:00.000Z",
        },
      ],
      interaction: [staffApproval({ state: "answered", resolution: { action: "accept" } })],
    });
    const rows = transcript(data, "mira");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "other", staffId: "staff-approval-juno" });
    expect(
      toStaffCard(staffApproval({ state: "answered", resolution: { action: "accept" } }))?.state,
    ).toBe("approved");
  });
});

describe("backup models", () => {
  it("writes the switch note as one line", () => {
    const note = {
      code: "model_switch",
      change: "switched",
      from: "Personal",
      to: "Work",
      until: "2026-11-19T15:00:00.000Z",
      text: "Personal hit its limit. Continuing on Work.",
    };
    expect(switchNoteText(note, clock)).toBe("Switched to Work. Back to Personal at 3:00 PM.");
    expect(switchNoteText({ ...note, change: "returned", to: "Personal" }, clock)).toBe(
      "Back on Personal.",
    );
    expect(switchNoteText({ ...note, change: "exhausted", to: undefined }, clock)).toBe(
      "Personal is at its limit and no backup is free. Work resumes at 3:00 PM.",
    );
    expect(switchNoteText({ code: "wake" })).toBeUndefined();
  });

  it("shows the switch note in the transcript", () => {
    const data = snapshot({
      item: [
        {
          id: "n1",
          threadId: "sam",
          seq: 1,
          kind: "note",
          body: {
            code: "model_switch",
            change: "returned",
            from: "Work",
            to: "Personal",
            text: "",
          },
          createdAt: "2026-11-19T15:00:00.000Z",
        },
      ],
    });
    expect(transcript(data, "sam")[0]).toMatchObject({
      switchNote: true,
      text: "Back on Personal.",
    });
  });

  it("reads the provider question and answers it the way the daemon expects", () => {
    const question = switchQuestion(
      {
        context: {
          toolInput: {
            backupSwitch: {
              from: "Claude · Work",
              to: "Codex",
              provider: "Codex",
              until: "2026-11-19T15:00:00.000Z",
              project: "Acme web",
            },
          },
        },
      },
      clock,
    );
    expect(question).toEqual({
      from: "Claude · Work",
      to: "Codex",
      provider: "Codex",
      until: "3:00 PM",
      project: "Acme web",
    });
    if (!question) return;
    expect(switchDetail(question, "Sam")).toBe(
      "Claude · Work is at its limit. Sam moves back at 3:00 PM.",
    );
    expect(switchAnswer(true, true).answers).toEqual({
      choice: { options: ["continue"] },
      remember: { options: ["remember"] },
    });
    expect(switchAnswer(false, true).answers).toEqual({
      choice: { options: ["wait"] },
      remember: { options: ["ask"] },
    });
    expect(switchQuestion({ context: {} })).toBeUndefined();
  });

  it("names the account a switched chat runs on", () => {
    const data = snapshot({
      agentDefinition: [{ id: "claude", displayName: "Claude" }],
      settings: [
        { key: "models.active.sam", value: { accountId: "acct-work", home: false } },
        { key: "models.account.acct-work", value: { label: "Work" } },
        { key: "models.active.theo", value: { accountId: "default:claude", home: true } },
      ],
    });
    expect(chatAccount(data, "sam")).toBe("Work");
    expect(chatAccount(data, "theo")).toBeUndefined();
    expect(chatAccount(data, "nobody")).toBeUndefined();
  });

  it("lists accounts with a status only when one needs saying", () => {
    const views = accountViews(
      [
        {
          id: "a",
          definitionId: "claude",
          label: "Personal",
          isDefault: false,
          login: "signed_in",
          limit: { resetsAt: "2026-11-19T15:00:00.000Z" },
        },
        { id: "b", definitionId: "codex", label: "Codex", isDefault: true, login: "signed_in" },
      ],
      [
        { id: "claude", displayName: "Claude" },
        { id: "codex", displayName: "Codex" },
      ],
      clock,
    );
    expect(views.map((view) => [view.name, view.status, view.state])).toEqual([
      ["Claude · Personal", "At limit · resets 3:00 PM", "limit"],
      ["Codex", "", "ready"],
    ]);
  });

  it("falls back to the employees' order and reorders entries", () => {
    const orders = toOrders({ employee: [{ accountId: "a" }, { accountId: "b" }], manager: null });
    expect(orderFor(orders, "manager")).toEqual(orders.employee);
    expect(moveEntry(["a", "b", "c"], 2, -1)).toEqual(["a", "c", "b"]);
    expect(moveEntry(["a", "b"], 0, -1)).toEqual(["a", "b"]);
  });

  it("reads the running limit, defaulting when unset or invalid", () => {
    expect(runningLimit(snapshot({}))).toBe(2);
    expect(runningLimit(snapshot({ settings: [{ key: "tasks.runningLimit", value: 5 }] }))).toBe(5);
    expect(runningLimit(snapshot({ settings: [{ key: "tasks.runningLimit", value: 50 }] }))).toBe(
      2,
    );
  });
});

describe("A7 free models", () => {
  it("adds only the free models the order lacks, within 8 places", () => {
    const free = toFreeModels([
      { accountId: "default:a", model: "x:free", name: "X" },
      { accountId: "default:a", model: "y:free", name: "Y" },
      { accountId: "", model: "bad" },
    ]);
    expect(free).toHaveLength(2);
    expect(missingFreeModels([{ accountId: "default:a", model: "x:free" }], free)).toEqual([
      { accountId: "default:a", model: "y:free" },
    ]);
    const full = Array.from({ length: 8 }, (_, i) => ({ accountId: `p${i}` }));
    expect(missingFreeModels(full, free)).toEqual([]);
  });
});
