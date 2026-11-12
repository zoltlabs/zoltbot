import { describe, expect, it } from "vitest";
import { threadChanges } from "./changes.js";
import { editsOf, forkInfo } from "./forks.js";
import { sampleSnapshot } from "./sample.js";
import {
  ago,
  chats,
  countsText,
  defaultProfileForPlace,
  deriveTaskTitle,
  directionRows,
  dispatchGroups,
  needsYou,
  place,
  projectSummaries,
  recentlyDone,
  resolvePlace,
  scopeRows,
  since,
  taskGroups,
  transcript,
  workingNow,
  zolt,
} from "./view.js";

const now = Date.parse("2026-11-03T12:00:00.000Z");
const snapshot = sampleSnapshot(now);

describe("mobile view helpers", () => {
  it("orders Needs you by Zolt's triage and shows its reasons", () => {
    const items = needsYou(snapshot, now);
    // now, today, then untriaged (blocking first, then oldest), as the desktop orders them.
    expect(items.map((item) => item.id)).toEqual([
      "approve-tests",
      "archived-question",
      "units-plan",
      "show-units",
    ]);
    expect(items[0]).toMatchObject({
      rank: "now",
      why: "Blocks the meal search task; the command only runs tests.",
    });
    expect(items[2]?.why).toBeUndefined();
  });
  it("falls back to kind order before Zolt has triaged anything, each with its own label", () => {
    const untriaged = {
      ...snapshot,
      entities: {
        ...snapshot.entities,
        settings: (snapshot.entities.settings ?? []).filter((row) => row.key !== "chief.queue"),
      },
    };
    const items = needsYou(untriaged, now);
    expect(items.map((item) => item.kind)).toEqual(["approval", "review", "plan", "question"]);
    expect(items[2]).toMatchObject({
      title: "Add a Units setting",
      label: "Plan",
      meta: "Plan · Builder · Zolt › App",
      threadId: "thread-unit-settings",
    });
    expect(items[3]).toMatchObject({ label: "Question", meta: "Question · Checker · Zolt › App" });
    expect(items[0]).toMatchObject({
      title: "Builder wants to run a command",
      meta: "Zolt › App · Meal search · 2 min",
      command: "pnpm test --filter meals",
      choices: ["allow_once", "reject_once"],
      diff: { files: 0, added: 0, removed: 0 },
    });
    expect(items[1]).toMatchObject({ title: "Show units", meta: "Task · Zolt › App · Revision 2" });
  });
  it("shows what each running thread is doing", () => {
    expect(workingNow(snapshot)).toEqual([
      expect.objectContaining({
        title: "Meal search",
        activity: "Running pnpm test --filter meals",
        isTask: true,
      }),
      expect.objectContaining({
        title: "Rate limits",
        activity: "Thinking",
        place: "Zolt › Backend",
      }),
    ]);
  });
  it("summarizes projects and groups tasks like the desktop", () => {
    const [zolt, site] = projectSummaries(snapshot);
    if (!zolt || !site) throw new Error("The sample has two projects");
    expect(countsText(zolt.counts)).toBe("4 needs you · 1 running · 1 queued");
    expect(zolt.directions.map((d) => d.name)).toEqual(["App", "Backend", "Marketing site"]);
    expect(countsText(site.counts)).toBe("Quiet");
    const groups = taskGroups(snapshot);
    expect(groups.needs_you.map((t) => t.title)).toEqual(["Show units"]);
    expect(groups.done.map((t) => t.title)).toEqual(["Weekly summary email", "Dark mode toggle"]);
    expect(directionRows(snapshot, "marketing")).toEqual([]);
    expect(directionRows(snapshot, "app")[0]?.row.title).toBe("Meal search");
  });
  it("turns items into transcript rows with diff counts", () => {
    const rows = transcript(snapshot, "thread-meal-search");
    expect(rows.map((row) => row.kind)).toEqual([
      "user",
      "message",
      "tool",
      "tool",
      "tool",
      "message",
    ]);
    expect(rows[3]).toMatchObject({
      text: "Edited src/meals/search.ts",
      added: 3,
      removed: 1,
      status: "ok",
    });
    expect(rows[5]?.streaming).toBe(true);
    expect(chats(snapshot)[0]).toMatchObject({ chief: true, thread: { id: "thread-zolt" } });
    expect(chats(snapshot)[1]).toMatchObject({ chief: false, working: true });
  });
  it("sums up Zolt for Home: its newest words, and whether they were the brief", () => {
    expect(zolt(snapshot)).toMatchObject({
      name: "Zolt",
      threadId: "thread-zolt",
      working: false,
      latest: { brief: true, text: expect.stringMatching(/^Morning\./) },
    });
    // The brief's wake item is an event in the transcript, not your words.
    expect(transcript(snapshot, "thread-zolt")).toMatchObject([
      { kind: "other", event: "brief", text: 'Finished: "Unit settings". Needs the user: 3.' },
      { kind: "message", brief: true },
    ]);
  });
  it("shows Zolt's notice on Home, never the notes it wrote to itself on a wake-up", () => {
    const at = "2026-11-03T11:59:00.000Z";
    const extra = [
      { id: "chief-wake:2026-11-03:1:abc", kind: "user", seq: 900, turnId: "wake-turn", body: {} },
      {
        id: "notice",
        kind: "note",
        seq: 901,
        turnId: "wake-turn",
        body: { code: "chief_notify", text: "The deploy needs your OK." },
      },
      {
        id: "to-self",
        kind: "message",
        seq: 902,
        turnId: "wake-turn",
        body: { text: "Told them." },
      },
    ].map((row) => ({ ...row, threadId: "thread-zolt", createdAt: at, updatedAt: at }));
    const woke = {
      ...snapshot,
      entities: { ...snapshot.entities, item: [...(snapshot.entities.item ?? []), ...extra] },
    };
    expect(zolt(woke).latest).toEqual({ text: "The deploy needs your OK.", at, brief: false });
    expect(transcript(woke, "thread-zolt").at(-2)).toMatchObject({
      kind: "message",
      text: "The deploy needs your OK.",
    });
  });
  it("lists chats that ended in the past day, failures included", () => {
    expect(recentlyDone(snapshot, now)).toEqual([
      expect.objectContaining({ title: "Sync API errors", failed: true }),
    ]);
  });
  it("writes short ages", () => {
    expect(ago("2026-11-03T11:58:00.000Z", now)).toBe("2 min");
    expect(ago("2026-11-03T09:00:00.000Z", now)).toBe("3 h");
    expect(ago("2026-11-02T10:00:00.000Z", now)).toBe("yesterday");
    expect(ago("2026-10-20T10:00:00.000Z", now)).toBe("Oct 20");
    expect(since("2026-11-03T11:58:00.000Z", now)).toBe("2 min ago");
    expect(since("2026-11-02T10:00:00.000Z", now)).toBe("yesterday");
    expect(since("2026-10-20T10:00:00.000Z", now)).toBe("on Oct 20");
  });
});

it("renders a Compare resolution note as a display-only result with a route back", () => {
  const rows = transcript(
    {
      seq: 1,
      entities: {
        item: [
          {
            id: "marker",
            threadId: "winner",
            seq: 1,
            kind: "note",
            body: { code: "compare", compareId: "group", count: 2 },
          },
        ],
      },
      counters: {},
    },
    "winner",
  );
  expect(rows).toMatchObject([
    {
      kind: "other",
      compareId: "group",
      text: "Compared 2 answers · continued here. The other answers are kept as side chats.",
    },
  ]);
});

it("labels your messages from the item's queue state, not the send result", () => {
  const user = (id: string, body: Record<string, unknown>) => ({
    id,
    threadId: "t",
    seq: Number(id.slice(1)),
    kind: "user",
    body: { input: [{ type: "text", text: id }], ...body },
  });
  const rows = transcript(
    {
      seq: 1,
      entities: {
        item: [
          user("u1", { queueState: "queued", mode: "steer" }),
          user("u2", { queueState: "sent", deliveryMode: "steer" }),
          user("u3", { queueState: "sent", deliveryMode: "queue" }),
          user("u4", { queueState: "failed", errorCode: "cancelled" }),
          user("u5", { queueState: "uncertain" }),
          user("u6", {}),
        ],
      },
      counters: {},
    },
    "t",
  );
  expect(rows.map((row) => [row.delivery, row.queued ?? false])).toEqual([
    ["Queued", true],
    ["Steered", false],
    [undefined, false],
    ["Cancelled", false],
    ["Delivery needs review", false],
    [undefined, false],
  ]);
});

it("groups a chat's file changes by the turn that made them", () => {
  expect(threadChanges(snapshot, "thread-meal-search")).toEqual([
    {
      turnId: "turn-meal",
      prompt: expect.stringContaining("Find meals by name"),
      at: expect.any(String),
      files: [{ path: "src/meals/search.ts", added: 3, removed: 1 }],
    },
  ]);
  expect(threadChanges(snapshot, "thread-rate-limits")).toEqual([]);
});

it("finds where a fork came from and pages through the edits of one message", () => {
  const thread = (id: string, createdAt: string, fork?: Record<string, unknown>) => ({
    id,
    title: id,
    archived: false,
    createdAt,
    ...(fork ? { fork } : {}),
  });
  const edit = (turnId: string) => ({
    kind: "copied",
    sourceThreadId: "a",
    copiedMessages: 2,
    boundary: { kind: "before_user", turnId },
  });
  const forks = {
    seq: 1,
    counters: {},
    entities: {
      thread: [
        thread("a", "2026-11-01"),
        thread("b", "2026-11-02", edit("t2")),
        thread("c", "2026-11-03", edit("t2")),
        thread("d", "2026-11-04", {
          kind: "native",
          sourceThreadId: "a",
          boundary: { kind: "latest" },
        }),
      ],
    },
  };
  expect(forkInfo(forks, "c")).toEqual({
    sourceThreadId: "a",
    sourceTitle: "a",
    kind: "copied",
    copiedMessages: 2,
    versions: { ids: ["a", "b", "c"], index: 2 },
  });
  expect(forkInfo(forks, "d")).toMatchObject({ kind: "native" });
  expect(forkInfo(forks, "d")?.versions).toBeUndefined();
  expect(forkInfo(forks, "a")).toBeUndefined();
  expect(editsOf(forks, "a")).toEqual(new Map([["t2", ["c", "b"]]]));
});

it("preserves wake history and evidence links on the phone", () => {
  const copy = structuredClone(snapshot);
  copy.entities.item = [
    {
      id: "woke",
      threadId: "wake-chat",
      kind: "note",
      seq: 1,
      createdAt: "2026-11-03T12:00:00Z",
      updatedAt: "2026-11-03T12:00:00Z",
      body: { code: "wake", text: "Tests finished", evidenceUrl: "#chat/source" },
    },
  ];
  expect(transcript(copy, "wake-chat")).toEqual([
    expect.objectContaining({
      text: "Tests finished",
      wakeEvidence: "#chat/source",
      kind: "other",
    }),
  ]);
});

describe("mobile task dispatch helpers", () => {
  it("groups workspaces project-first and marks teamless single-repo projects for direct selection", () => {
    const custom = structuredClone(snapshot);
    const soloProject = {
      ...custom.entities.project?.[0],
      id: "solo",
      name: "Solo repo",
      roots: [{ path: "/Users/you/Projects/solo", label: "Solo repo" }],
    };
    custom.entities.project = [
      ...(custom.entities.project ?? []),
      soloProject,
      {
        ...custom.entities.project?.[0],
        id: "multi",
        name: "Multi repo",
        roots: [
          { path: "/Users/you/Projects/web", label: "Web" },
          { path: "/Users/you/Projects/api", label: "API" },
        ],
      },
    ];
    custom.entities.subproject = [
      ...(custom.entities.subproject ?? []),
      {
        id: "ios",
        projectId: "zolt",
        parentId: "app",
        name: "iOS",
        label: "Team",
        goal: "",
        instructions: "",
        depth: 2,
        archived: false,
        createdAt: "2026-10-10T00:00:00.000Z",
      },
    ];
    const groups = dispatchGroups(custom);
    expect(groups.map((g) => [g.projectId, g.directSelect])).toEqual([
      ["zolt", false],
      ["site", false],
      ["solo", true],
      ["multi", false],
    ]);
    expect(groups[0]?.teams.map((t) => t.label)).toEqual([
      "App",
      "App › iOS",
      "Backend",
      "Marketing site",
    ]);
    expect(groups[2]?.root).toEqual({
      key: "project:solo",
      projectId: "solo",
      node: { type: "project", id: "solo" },
      label: "Solo repo",
      fullLabel: "Solo repo",
    });
    expect(resolvePlace(custom, groups, "project:solo")?.node).toEqual({
      type: "project",
      id: "solo",
    });
    expect(resolvePlace(custom, groups, "solo")?.key).toBe("project:solo");
    expect(resolvePlace(custom, groups, "backend")?.key).toBe("subproject:backend");
    expect(resolvePlace(custom, groups)?.key).toBe("subproject:app");

    const freshSolo = {
      seq: 1,
      counters: {},
      entities: { project: [soloProject] },
    };
    const soloGroups = dispatchGroups(freshSolo);
    expect(resolvePlace(freshSolo, soloGroups)?.node).toEqual({ type: "project", id: "solo" });
  });

  it("picks the last-used profile per scope or project, then project default, skipping designers", () => {
    const groups = dispatchGroups(snapshot);
    const app = resolvePlace(snapshot, groups, "subproject:app");
    const backend = resolvePlace(snapshot, groups, "subproject:backend");
    const zoltRoot = resolvePlace(snapshot, groups, "project:zolt");
    expect(defaultProfileForPlace(snapshot, app)).toBe("builder");
    expect(defaultProfileForPlace(snapshot, backend)).toBe("checker");
    expect(defaultProfileForPlace(snapshot, zoltRoot)).toBe("builder");

    const configured = structuredClone(snapshot);
    configured.entities.project = (configured.entities.project ?? []).map((row) =>
      row.id === "site" ? { ...row, defaultAgentId: "checker" } : row,
    );
    const siteRoot = resolvePlace(configured, dispatchGroups(configured), "project:site");
    expect(defaultProfileForPlace(configured, siteRoot)).toBe("checker");

    const withDesigner = structuredClone(snapshot);
    withDesigner.entities.agent = [
      {
        ...withDesigner.entities.agent?.[0],
        id: "designer",
        name: "Designer",
        template: "artifact_designer",
      },
      ...(withDesigner.entities.agent ?? []),
    ];
    const unconfiguredSite = resolvePlace(
      withDesigner,
      dispatchGroups(withDesigner),
      "project:site",
    );
    expect(defaultProfileForPlace(withDesigner, unconfiguredSite)).toBe("builder");
  });

  it("derives clean task titles from single-line, multiline, markdown and long prompts", () => {
    expect(deriveTaskTitle("")).toBe("");
    expect(deriveTaskTitle("   \n\t  ")).toBe("");
    expect(deriveTaskTitle("Fix login redirect\n\nKeep query params after sign-in.")).toBe(
      "Fix login redirect",
    );
    expect(deriveTaskTitle("\n  ##   Add   dark mode toggle \nMore details")).toBe(
      "Add dark mode toggle",
    );
    expect(deriveTaskTitle("- Update rate limit headers")).toBe("Update rate limit headers");
    expect(deriveTaskTitle("#128 crashes when offline")).toBe("#128 crashes when offline");
    const long =
      "Refactor the mobile task dispatch flow so picking a single-repo workspace selects it right away without an extra team prompt";
    const title = deriveTaskTitle(long);
    expect(title.endsWith("…")).toBe(true);
    expect(title.length).toBeLessThanOrEqual(80);
    expect(deriveTaskTitle("x".repeat(250), 200).length).toBeLessThanOrEqual(150);
  });

  it("lists tasks and chats scoped directly to a project root", () => {
    const custom = structuredClone(snapshot);
    custom.entities.task = [
      ...(custom.entities.task ?? []),
      {
        ...custom.entities.task?.[0],
        id: "root-task",
        projectId: "site",
        node: { type: "project", id: "site" },
        title: "Refresh homepage hero",
        updatedAt: "2026-11-03T11:59:30.000Z",
      },
    ];
    expect(place(custom, custom.entities.task.at(-1))).toBe("Zoltbot site");
    expect(scopeRows(custom, { type: "project", id: "site" }).map((r) => r.row.id)).toEqual([
      "root-task",
    ]);
  });
});
