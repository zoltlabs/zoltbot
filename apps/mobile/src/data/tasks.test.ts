import { Value } from "@sinclair/typebox/value";
import { entitySchemas } from "@zoltbot/protocol";
import { describe, expect, it } from "vitest";
import { channelRows, drawerChats, drawerPeople, resolveProject, workSummary } from "./drawer.js";
import { addSampleCompany, sampleCompany } from "./fake-company.js";
import { sampleSnapshot } from "./sample.js";
import {
  filterOptions,
  filterTasks,
  groupTaskViews,
  needsYouTasks,
  taskMeta,
  taskPill,
  taskViews,
} from "./tasks.js";
import type { Row, Snapshot } from "./transport.js";

const now = Date.parse("2026-11-19T12:00:00.000Z");
const at = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

function companySnapshot(): Snapshot {
  const entities = sampleSnapshot(now).entities;
  addSampleCompany(entities, now);
  return { seq: 1, counters: {}, entities };
}

const base = (id: string, state: string, extra: Row = {}): Row => ({
  id,
  title: id,
  state,
  projectId: "p",
  ownerAgentId: "sam",
  createdAt: at(30),
  updatedAt: at(10),
  ...extra,
});

describe("task views", () => {
  it("words hold reasons the way the desktop does, capitalized for the phone", () => {
    const snapshot: Snapshot = {
      seq: 0,
      counters: {},
      entities: {
        task: [
          base("limit", "queued", { holdReason: "at_limit" }),
          base("dep", "blocked", {
            holdReason: "Waiting for accepted dependencies",
            dependencies: ["done", "migrate"],
          }),
          base("done", "completed"),
          base("migrate", "failed", { title: "Migrate invoices", holdReason: "Tests failed" }),
          base("folder", "queued", { holdReason: "Waiting for “Meal search” to finish in app" }),
          base("crash", "failed", { holdReason: "The agent turn failed (rate_limited)" }),
          base("restart", "blocked", { holdReason: "daemon_restarted" }),
          base("run", "running", { holdReason: "ignored" }),
        ],
      },
    };
    const reasons = Object.fromEntries(taskViews(snapshot).map((t) => [t.id, t.reason]));
    expect(reasons).toEqual({
      limit: "At limit",
      dep: "Waits on Migrate invoices",
      done: "",
      migrate: "Tests failed",
      folder: "Waits on Meal search",
      crash: "Usage limit",
      restart: "Waiting to resume",
      run: "",
    });
  });

  it("groups needs-you, running with blocked, queued in start order and done", () => {
    const snapshot: Snapshot = {
      seq: 0,
      counters: {},
      entities: {
        project: [
          { id: "p", name: "Acme" },
          { id: "old", name: "Old", archived: true },
        ],
        task: [
          base("r", "review"),
          base("f", "failed", { updatedAt: at(1) }),
          base("b", "blocked"),
          base("q2", "queued", { createdAt: at(5) }),
          base("q1", "queued", { createdAt: at(50) }),
          base("c", "completed"),
          base("x", "cancelled"),
          base("gone", "review", { projectId: "old" }),
        ],
      },
    };
    const groups = groupTaskViews(taskViews(snapshot));
    expect(
      Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.map((t) => t.id)])),
    ).toEqual({ needs_you: ["f", "r"], running: ["b"], queued: ["q1", "q2"], done: ["c", "x"] });
    expect(needsYouTasks(snapshot)).toBe(2);
    expect(needsYouTasks(snapshot, "other")).toBe(0);
  });

  it("filters by team and owner and lists the choices by name", () => {
    const views = taskViews(companySnapshot());
    expect(filterOptions(views, "owner").map((o) => o.name)).toEqual(["Builder", "Sam", "Theo"]);
    expect(filterOptions(views, "team").map((o) => o.name)).toEqual(["App", "Backend", "Web"]);
    const sam = filterTasks(views, { ownerId: "agent-sam", projectId: "acme-web" });
    expect(sam.map((t) => t.title)).toEqual([
      "Fix checkout tax rounding",
      "Add VAT number field",
      "Update receipt emails",
    ]);
    expect(filterTasks(views, { ownerId: "agent-sam", teamId: "app" })).toEqual([]);
    expect(filterTasks(views, { projectId: "site" })).toEqual([]);
  });

  it("shows a pill only where the group doesn't already say it", () => {
    expect(
      ["review", "failed", "blocked", "running", "queued"].map((s) => taskPill(s)?.label),
    ).toEqual(["Review", "Failed", "Blocked", undefined, undefined]);
    const [queued] = taskViews(companySnapshot()).filter((t) => t.id === "task-receipts");
    expect(queued && taskMeta(queued, now)).toBe("Sam · Web · At limit");
    const [running] = taskViews(companySnapshot()).filter((t) => t.id === "task-rounding");
    expect(running && taskMeta(running, now)).toBe("Sam · Web · 35m");
  });
});

describe("drawer", () => {
  it("lists the CEO, managers with what they wait on and employees with their work", () => {
    const snapshot = companySnapshot();
    const people = drawerPeople(snapshot, "acme-web", taskViews(snapshot));
    expect(people.map((p) => [p.name, p.role, p.meta, p.tasks.length])).toEqual([
      ["Ada", "ceo", "CEO", 0],
      ["Mira", "manager", "Waiting on 2 tasks", 0],
      ["Sam", "employee", "1 running · 1 to review · 1 queued", 3],
      ["Theo", "employee", "2 running · 1 failed", 3],
    ]);
    const zolt = drawerPeople(snapshot, "zolt", taskViews(snapshot));
    expect(zolt.map((p) => [p.name, p.meta])).toEqual([
      ["Builder", "1 running · 1 to review · 1 queued"],
    ]);
    expect(people.find((p) => p.name === "Sam")?.tasks.map((t) => t.state)).toEqual([
      "running",
      "review",
      "queued",
    ]);
  });

  it("opens a single task straight away and names its state", () => {
    const snapshot: Snapshot = {
      seq: 0,
      counters: {},
      entities: {
        agent: [{ id: "theo", name: "Theo" }],
        thread: [{ id: "t1", projectId: "p" }],
        task: [base("one", "blocked", { ownerAgentId: "theo", threadId: "t1" })],
      },
    };
    expect(drawerPeople(snapshot, "p", taskViews(snapshot))).toMatchObject([
      { name: "Theo", meta: "Blocked", threadId: "t1", tasks: [] },
    ]);
    expect(workSummary([])).toBe("");
  });

  it("keeps the project's own chats and its channels, the project channel first", () => {
    const snapshot = companySnapshot();
    const chats = drawerChats(snapshot, "acme-web", now).map((c) => c.title);
    expect(chats).toContain("EU pricing questions");
    expect(chats).not.toContain("Mira");
    expect(chats).not.toContain("Add VAT number field");
    // A3: a muted chat says so.
    const chat = drawerChats(snapshot, "acme-web", now).find(
      (c) => c.title === "EU pricing questions",
    );
    expect(chat?.muted).toBe(false);
    snapshot.entities.settings = [
      ...(snapshot.entities.settings ?? []),
      { key: `chat.muted.${chat?.threadId}`, value: true },
    ];
    expect(
      drawerChats(snapshot, "acme-web", now).find((c) => c.threadId === chat?.threadId)?.muted,
    ).toBe(true);
    expect(
      channelRows(
        snapshot.entities.channel ?? [],
        snapshot.entities.channelRequest ?? [],
        "acme-web",
      ),
    ).toEqual([
      { id: "channel-acme-all", name: "acme-web", active: 0 },
      { id: "channel-acme-web", name: "web", active: 1 },
    ]);
    const channels: Row[] = [
      { id: "t", projectId: "p", kind: "team", name: "data" },
      { id: "old", projectId: "p", kind: "team", name: "old", archivedAt: at(1) },
      { id: "p", projectId: "p", kind: "project", name: "acme" },
    ];
    expect(
      channelRows(
        channels,
        [
          { channelId: "t", state: "open" },
          { channelId: "t", state: "done" },
        ],
        "p",
      ),
    ).toEqual([
      { id: "p", name: "acme", active: 0 },
      { id: "t", name: "data", active: 1 },
    ]);
  });

  it("falls back to the project with the newest chat", () => {
    const snapshot = companySnapshot();
    expect(resolveProject(snapshot, "site")).toBe("site");
    expect(resolveProject(snapshot, "missing")).toBe("zolt");
  });

  it("uses the real protocol entity shapes", () => {
    for (const [kind, rows] of Object.entries(sampleCompany(now))) {
      const schema = entitySchemas[kind as keyof typeof entitySchemas];
      expect(schema, kind).toBeDefined();
      for (const row of rows)
        expect(Value.Errors(schema, row).First(), `${kind} ${row.id}`).toBeUndefined();
    }
  });
});
