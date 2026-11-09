import type { Row, Snapshot } from "./transport.js";

// Sample work for the fake transport, in the real @zoltbot/protocol entity shapes (a test checks
// every row against entitySchemas). Times are relative to `now`, so the app always looks current.

export const sampleMacName = "Example MacBook Pro";

export function sampleSnapshot(now = Date.now()): Snapshot {
  const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  const human = { kind: "human", id: "human" } as const;
  const scope = (id: string) => ({ type: "subproject", id }) as const;

  const project = (id: string, name: string, goal: string, path: string): Row => ({
    id,
    name,
    goal,
    instructions: "",
    constraints: "",
    roots: [{ path, label: name }],
    hierarchyDepth: 1,
    tags: [],
    requireCodeReview: true,
    skipFinalGateWhenReviewed: false,
    archived: false,
    createdAt: ago(60 * 24 * 40),
  });
  const direction = (id: string, projectId: string, name: string, goal: string): Row => ({
    id,
    projectId,
    name,
    label: "Team",
    goal,
    instructions: "",
    depth: 1,
    archived: false,
    createdAt: ago(60 * 24 * 30),
  });
  const profile = (id: string, name: string, definitionId: string, model?: string): Row => ({
    id,
    name,
    avatar: name.slice(0, 1),
    kind: "profile",
    definitionId,
    ...(model ? { model } : {}),
    permissionProfile: "workspace_write",
    instructions:
      id === "builder"
        ? "You build features in the Zolt app. Keep changes small and run the tests before you finish."
        : "You review changes for bugs and missing tests. Ask before you change code.",
    hidden: false,
    archived: false,
    createdAt: ago(60 * 24 * (id === "builder" ? 50 : 49)),
  });
  const definition = (id: string, displayName: string): Row => ({
    id,
    displayName,
    adapter: id,
    binaryNames: [id],
    versionCommand: [id, "--version"],
    launch: { command: id, args: [], env: {} },
    testedVersions: "*",
    defaults: { permissionProfile: "workspace_write" },
    staticCapabilities: {},
    nativeSessionRoots: [],
    experimental: false,
  });
  const thread = (
    id: string,
    agentId: string,
    projectId: string,
    node: string,
    title: string,
    minutes: number,
    taskId?: string,
  ): Row => ({
    id,
    agentId,
    projectId,
    node: scope(node),
    ...(taskId ? { taskId } : {}),
    kind: taskId ? "task" : "main",
    title,
    titleSource: "human",
    pinned: false,
    archived: false,
    createdAt: ago(minutes + 30),
    lastActivityAt: ago(minutes),
  });
  const task = (
    id: string,
    node: string,
    title: string,
    state: string,
    minutes: number,
    extra: Row = {},
  ): Row => ({
    id,
    projectId: "zolt",
    node: scope(node),
    rootId: id,
    title,
    brief: title,
    acceptance: "",
    expectedDeliverable: "A tested change",
    ownerAgentId: "builder",
    threadId: `thread-${id}`,
    workspaceMode: "worktree",
    state,
    revision: 1,
    attempt: 1,
    maxAttempts: 3,
    reviewRequired: true,
    executionLocation: "local",
    createdBy: human,
    createdAt: ago(minutes + 20),
    updatedAt: ago(minutes),
    ...extra,
  });
  const item = (
    id: string,
    threadId: string,
    seq: number,
    kind: string,
    body: Row,
    turnId?: string,
  ): Row => ({
    id,
    threadId,
    ...(turnId ? { turnId } : {}),
    seq,
    kind,
    body,
    createdAt: ago(5 - seq * 0.5),
    updatedAt: ago(5 - seq * 0.5),
  });
  const session = (id: string, threadId: string, provider: string, extra: Row = {}): Row => ({
    id,
    threadId,
    provider,
    cwd: "/Users/you/Projects/zolt-app",
    state: "running",
    capabilities: {},
    startedAt: ago(10),
    ...extra,
  });
  const modes = {
    steer: "native",
    models: {
      selectable: true,
      list: [
        { id: "opus", name: "Opus 5.5" },
        { id: "sonnet", name: "Sonnet 5.5" },
      ],
    },
    effort: ["low", "medium", "high", "xhigh", "max"],
    modes: ["default", "acceptEdits", "plan", "bypassPermissions"],
    safeModes: ["default", "plan"],
  };
  const turn = (id: string, threadId: string, sessionId: string): Row => ({
    id,
    threadId,
    sessionId,
    status: "running",
    origin: "human",
    startedAt: ago(4),
  });
  const device = (id: string, name: string, days: number, minutes: number): Row => ({
    id,
    name,
    platform: "ios",
    publicKey: `${id}-key`,
    state: "paired",
    createdAt: ago(60 * 24 * days),
    pairedAt: ago(60 * 24 * days),
    lastSeenAt: ago(minutes),
    archived: false,
  });
  const interaction = (row: Row): Row => ({
    chain: [],
    urgency: "blocking",
    version: 1,
    state: "pending",
    ...row,
  });
  const meal = "thread-meal-search";
  const zolt = "thread-zolt";
  const ended = (
    id: string,
    threadId: string,
    sessionId: string,
    status: string,
    started: number,
    end: number,
  ): Row => ({
    ...turn(id, threadId, sessionId),
    status,
    startedAt: ago(started),
    endedAt: ago(end),
  });
  const units = "thread-unit-settings";

  const entities: Record<string, Row[]> = {
    project: [
      project("zolt", "Zolt", "A food log that is fast to use.", "~/Projects/zolt-app"),
      project("site", "Zoltbot site", "The public site and docs.", "~/Projects/zoltbot-site"),
    ],
    subproject: [
      direction("app", "zolt", "App", "The iPhone app"),
      direction("backend", "zolt", "Backend", "Sync and accounts"),
      direction("marketing", "zolt", "Marketing site", "Pages that explain Zolt"),
      direction("landing", "site", "Landing", "The home page"),
      direction("docs", "site", "Docs", "Guides"),
    ],
    agent: [
      profile("builder", "Builder", "claude", "Opus 5.5"),
      profile("checker", "Checker", "codex"),
    ],
    agentDefinition: [definition("claude", "Claude"), definition("codex", "Codex")],
    thread: [
      thread(meal, "builder", "zolt", "app", "Meal search", 1, "meal-search"),
      thread("thread-show-units", "builder", "zolt", "app", "Show units", 25, "show-units"),
      thread("thread-barcode-scan", "builder", "zolt", "app", "Barcode scan", 40, "barcode-scan"),
      thread("thread-rate-limits", "checker", "zolt", "backend", "Rate limits", 2),
      thread("thread-archived", "checker", "zolt", "app", "Archived meals", 6),
      thread("thread-unit-settings", "builder", "zolt", "app", "Unit settings", 60 * 26),
      thread("thread-sync-errors", "builder", "zolt", "backend", "Sync API errors", 180),
      thread(
        "thread-weekly-summary",
        "builder",
        "zolt",
        "backend",
        "Weekly summary email",
        60 * 24 * 4,
        "weekly-summary",
      ),
      {
        ...thread(zolt, "builder", "", "", "Zolt", 50),
        projectId: undefined,
        node: undefined,
      },
      thread(
        "thread-dark-mode",
        "builder",
        "zolt",
        "app",
        "Dark mode toggle",
        60 * 24 * 5,
        "dark-mode",
      ),
    ],
    session: [
      session("session-zolt", zolt, "claude"),
      session("session-meal", meal, "claude", {
        capabilities: modes,
        mode: "default",
        model: "opus",
        background: [
          {
            id: "bg-dev",
            kind: "shell",
            description: "pnpm dev --filter app",
            state: "running",
            startedAt: ago(8),
          },
        ],
      }),
      session("session-units", units, "claude", {
        state: "ready",
        capabilities: modes,
        mode: "plan",
      }),
      session("session-rate", "thread-rate-limits", "codex"),
    ],
    turn: [
      turn("turn-meal", meal, "session-meal"),
      turn("turn-rate", "thread-rate-limits", "session-rate"),
      ended("turn-zolt-brief", zolt, "session-zolt", "completed", 52, 50),
      ended("turn-units", units, "session-units", "completed", 60 * 26 + 5, 60 * 26),
      ended("turn-sync", "thread-sync-errors", "session-units", "failed", 190, 180),
    ],
    item: [
      item(
        `chief-wake:brief:${new Date(now).toLocaleDateString("en-CA")}`,
        zolt,
        1,
        "user",
        {
          input: [
            {
              type: "text",
              text: '[Zoltbot] Morning brief.\nFinished: "Unit settings". Needs the user: 3.',
            },
          ],
          queueState: "sent",
        },
        "turn-zolt-brief",
      ),
      item(
        "zolt-brief",
        zolt,
        2,
        "message",
        {
          text: "Morning. Builder finished Unit settings overnight. Sync API errors failed on a flaky test. Two things need you: the meal search test run, and whether archived meals stay in search.",
        },
        "turn-zolt-brief",
      ),
      item(
        "i1",
        meal,
        1,
        "user",
        {
          input: [
            { type: "text", text: "Find meals by name. Search should ignore case and accents." },
          ],
          queueState: "sent",
        },
        "turn-meal",
      ),
      item(
        "i2",
        meal,
        2,
        "message",
        {
          text: "I’ll add a search field above the meal list and filter on the meal name, folding case and accents first.",
        },
        "turn-meal",
      ),
      item(
        "i3",
        meal,
        3,
        "tool",
        {
          name: "Read",
          kind: "read",
          status: "ok",
          input: { path: "src/meals/list.tsx" },
        },
        "turn-meal",
      ),
      item(
        "i4",
        meal,
        4,
        "tool",
        {
          name: "Edit",
          kind: "edit",
          status: "ok",
          input: { path: "src/meals/search.ts" },
          diffs: [
            {
              path: "src/meals/search.ts",
              patch: [
                "@@ -1,3 +1,5 @@",
                "-const match = (meal, query) => meal.name.includes(query);",
                '+const fold = (text) => text.normalize("NFD").replace(/\\p{M}/gu, "").toLowerCase();',
                "+const match = (meal, query) => fold(meal.name).includes(fold(query));",
                "+export const search = (meals, query) => meals.filter((meal) => match(meal, query));",
              ].join("\n"),
            },
          ],
        },
        "turn-meal",
      ),
      item(
        "i5",
        meal,
        5,
        "tool",
        {
          name: "Bash",
          kind: "execute",
          status: "running",
          input: { command: "pnpm test --filter meals" },
        },
        "turn-meal",
      ),
      item(
        "i6",
        meal,
        6,
        "message",
        {
          text: "The filter works on its own. Now wiring the field into the list so results update as you type",
          streaming: true,
        },
        "turn-meal",
      ),
      item("i7", "thread-rate-limits", 1, "user", {
        input: [{ type: "text", text: "Check the sync API for missing rate limits." }],
      }),
      item(
        "i8",
        "thread-rate-limits",
        2,
        "thought",
        { text: "Reading the route table", streaming: true },
        "turn-rate",
      ),
      item("u1", units, 1, "user", {
        input: [{ type: "text", text: "Let people pick grams or ounces in Settings." }],
      }),
      item(
        "u2",
        units,
        2,
        "plan",
        {
          entries: [
            { step: "Find where units are read", status: "completed" },
            { step: "Write the plan", status: "in_progress" },
            { step: "Add the Units setting", status: "pending" },
          ],
        },
        "turn-units",
      ),
      item(
        "u3",
        units,
        3,
        "tool",
        {
          nativeItemId: "agent-explore",
          name: "Agent",
          kind: "agent",
          title: "Explore unit handling",
          status: "ok",
          input: {},
        },
        "turn-units",
      ),
      item(
        "u4",
        units,
        4,
        "tool",
        {
          parentItemId: "agent-explore",
          name: "Grep",
          kind: "search",
          title: "grams",
          status: "ok",
          input: {},
        },
        "turn-units",
      ),
      item(
        "u5",
        units,
        5,
        "message",
        { parentItemId: "agent-explore", text: "Units are formatted in src/meals/units.ts." },
        "turn-units",
      ),
      item(
        "u6",
        units,
        6,
        "tool",
        { name: "Plan", kind: "mode", interactive: true, status: "running", input: {} },
        "turn-units",
      ),
      item("u7", units, 7, "interaction", { interactionId: "units-plan" }, "turn-units"),
    ],
    task: [
      task("show-units", "app", "Show units", "review", 25, { revision: 2 }),
      task("meal-search", "app", "Meal search", "running", 4),
      task("barcode-scan", "app", "Barcode scan", "queued", 40, {
        holdReason: "Waiting for “Meal search” to finish in zolt-app",
      }),
      task("weekly-summary", "backend", "Weekly summary email", "completed", 60 * 24 * 4),
      task("dark-mode", "app", "Dark mode toggle", "cancelled", 60 * 24 * 5),
    ],
    taskResult: [
      {
        taskId: "show-units",
        revision: 2,
        status: "done",
        summary: "Meals show grams or ounces from the new Units setting. Tests pass.",
        files: ["src/meals/units.ts", "src/settings/units.tsx"],
        digest: "",
        auto: false,
        createdAt: ago(25),
      },
    ],
    interaction: [
      interaction({
        id: "approve-tests",
        agentId: "builder",
        threadId: meal,
        taskId: "meal-search",
        type: "approval",
        title: "Builder wants to run a command",
        context: { toolName: "Bash", toolKind: "execute", command: "pnpm test --filter meals" },
        items: [
          {
            id: "run",
            prompt: "Run pnpm test --filter meals?",
            choices: [{ id: "allow_once" }, { id: "reject_once" }],
          },
        ],
        createdAt: ago(2),
      }),
      interaction({
        id: "units-plan",
        agentId: "builder",
        threadId: units,
        turnId: "turn-units",
        type: "plan",
        title: "Add a Units setting",
        context: {
          markdown: [
            "## Plan",
            "1. Add a **Units** row to Settings with grams and ounces.",
            "2. Read the choice in `formatAmount`.",
            "3. Update the meal list tests.",
            "",
            "- [x] Checked current formatting",
            "- [ ] Migrate saved meals",
          ].join("\n"),
        },
        items: [
          {
            id: "plan",
            prompt: "Approve this plan?",
            choices: [{ id: "allow_accept_edits" }, { id: "allow_once" }, { id: "reject_once" }],
          },
        ],
        createdAt: ago(3),
      }),
      interaction({
        id: "archived-question",
        agentId: "checker",
        threadId: "thread-archived",
        type: "question",
        title: "Include archived meals in search?",
        items: [
          {
            id: "archived",
            header: "Archived",
            prompt: "Include archived meals in search?",
            options: [
              { id: "yes", label: "Yes, include them" },
              { id: "no", label: "No, leave them out", recommended: true },
            ],
          },
        ],
        urgency: "background",
        createdAt: ago(6),
      }),
    ],
    device: [
      device("this-iphone", "This iPhone", 0, 0),
      device("ipad", "Example iPad", 20, 60 * 48),
    ],
    settings: [
      { key: "chief.name", value: "Zolt" },
      { key: "chief.thread", value: zolt },
      {
        key: "chief.proactive",
        value: { enabled: true, maxTurnsPerDay: 5, brief: { enabled: true, time: "08:30" } },
      },
      {
        key: "chief.queue",
        value: {
          items: {
            "approve-tests": {
              rank: "now",
              why: "Blocks the meal search task; the command only runs tests.",
              recommend: { decision: "approve" },
              at: ago(1),
            },
            "archived-question": {
              rank: "today",
              why: "Decides what search shows; nothing waits on it yet.",
              at: ago(5),
            },
          },
        },
      },
      { key: "mobile.this-iphone.notifyNeedsYou", value: true },
      { key: "mobile.this-iphone.notifyResults", value: true },
      { key: "mobile.this-iphone.notifyZolt", value: true },
      { key: "mobile.this-iphone.pushTitles", value: false },
      { key: "mobile.this-iphone.keepAwake", value: true },
    ],
  };
  return { seq: 100, entities, counters: { pendingInteractions: 3 } };
}
