(() => {
  // Sample data for mock mode. The default case has six chats, one in each state a view should
  // handle. Add `#chats=200` (any count up to 500) to the preview URL for a large case.
  const providers = [
    { id: "claude", name: "Claude Code" },
    { id: "codex", name: "Codex" },
    { id: "gemini", name: "Gemini" },
    { id: "cursor", name: "Cursor" },
    { id: "opencode", name: "OpenCode" },
    { id: "grok", name: "Grok" },
    { id: "pi", name: "Pi" },
  ];
  const approval = (id, chatId, title, command, createdAt) => ({
    id,
    version: 1,
    chatId,
    type: "approval",
    title,
    urgency: "blocking",
    createdAt,
    context: { command },
    choices: [
      { id: "allow_once", label: "Allow once", widens: false },
      { id: "allow_session", label: "Allow for this session", widens: true },
      { id: "reject_once", label: "Reject once", widens: false },
    ],
  });
  function small(at) {
    const chat = (id, title, status, workspaceId, provider, extra = {}) => ({
      id,
      title,
      kind: "main",
      status,
      profile: { id: "builder", name: "Builder" },
      provider,
      workspaceId,
      worktree: { id: `tree-${workspaceId}`, kind: "folder" },
      requestIds: [],
      startedAt: at,
      updatedAt: at,
      usage: { costUsd: 0.04, inputTokens: 300, outputTokens: 100 },
      ...extra,
    });
    const branch = (id, name) => ({ id, kind: "worktree", branch: name, baseRef: "main" });
    const chats = [
      chat("demo-build", "Build the page", "working", "demo-app", providers[0], {
        activity: "Editing the page layout",
      }),
      chat("demo-check", "Check the result", "needs_you", "demo-app", providers[1]),
      chat("demo-notes", "Write the notes", "idle", "demo-docs", providers[2]),
      chat("demo-review", "Tidy the styles", "review", "demo-app", providers[3], {
        worktree: branch("tree-styles", "tidy-styles"),
        lastTurn: { status: "completed", endedAt: at },
      }),
      chat("demo-later", "Plan the next release", "later", "demo-docs", providers[4]),
      chat("demo-failed", "Update the dependencies", "idle", "demo-docs", providers[6], {
        worktree: branch("tree-deps", "update-deps"),
        lastTurn: { status: "failed", endedAt: at },
      }),
    ];
    chats[1].requestIds = ["demo-request"];
    return {
      chats,
      requests: [approval("demo-request", "demo-check", "Run the checks?", "pnpm test", at)],
      workspaces: [
        { id: "demo-app", name: "Demo app", roots: [{ label: "App", isRepository: true }] },
        { id: "demo-docs", name: "Demo docs", roots: [{ label: "Docs", isRepository: true }] },
      ],
      usage: {
        today: { costUsd: 0.12, costKnown: true, inputTokens: 900, outputTokens: 300 },
        budget: { limitUsd: 10, period: "day" },
        activeChats: 2,
      },
      checks: [{ chatId: "demo-build", name: "Tests", state: "passing", required: true }],
    };
  }
  function large(count, now) {
    let seed = 20261111;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const pick = (list) => list[Math.floor(random() * list.length)];
    const names = ["Web app", "Mobile app", "Billing", "Search", "Docs site", "Design system"];
    const verbs = ["Fix", "Add", "Refactor", "Test", "Document", "Speed up", "Review", "Migrate"];
    const things = ["sign-in", "the cart", "search results", "exports", "the editor", "settings"];
    const branches = ["fix", "feature", "chore", "spike"];
    const workspaces = names.slice(0, Math.max(2, Math.min(names.length, Math.ceil(count / 30))));
    const chats = [],
      requests = [];
    for (let index = 0; index < count; index++) {
      const workspace = index % workspaces.length,
        tree = Math.floor(random() * Math.max(2, Math.ceil(count / workspaces.length / 5)));
      const roll = random(),
        status =
          roll < 0.45
            ? "working"
            : roll < 0.52
              ? "needs_you"
              : roll < 0.68
                ? "review"
                : roll < 0.8
                  ? "later"
                  : "idle";
      const age = Math.floor(random() * 50 * 60000),
        at = new Date(now - age).toISOString(),
        id = `demo-${index}`;
      const chat = {
        id,
        title: `${pick(verbs)} ${pick(things)}`,
        kind: "main",
        status,
        profile: { id: "builder", name: "Builder" },
        provider: pick(providers),
        workspaceId: `demo-space-${workspace}`,
        worktree:
          tree === 0
            ? { id: `tree-${workspace}`, kind: "folder" }
            : {
                id: `tree-${workspace}-${tree}`,
                kind: "worktree",
                branch: `${pick(branches)}/${pick(things).replace(/^the /, "").replaceAll(" ", "-")}-${tree}`,
                baseRef: "main",
              },
        requestIds: [],
        startedAt: at,
        updatedAt: at,
        usage: { costUsd: 0.04, inputTokens: 300, outputTokens: 100 },
      };
      if (status === "working") chat.activity = "Running the tests";
      if (status === "idle" && random() < 0.3) chat.lastTurn = { status: "failed", endedAt: at };
      if (status === "working" && random() < 0.05) chat.problem = { kind: "rate_limited" };
      if (status === "needs_you") {
        chat.requestIds = [`demo-request-${index}`];
        requests.push(approval(chat.requestIds[0], id, "Run the checks?", "pnpm test", at));
      }
      chats.push(chat);
    }
    return {
      chats,
      requests,
      workspaces: workspaces.map((name, index) => ({
        id: `demo-space-${index}`,
        name,
        roots: [{ label: name, isRepository: true }],
      })),
      usage: {
        today: { costUsd: 18.4, costKnown: true, inputTokens: 90000, outputTokens: 30000 },
        budget: { limitUsd: 40, period: "day" },
        activeChats: chats.filter((chat) => ["working", "needs_you"].includes(chat.status)).length,
      },
      checks: [{ chatId: "demo-0", name: "Tests", state: "failing", required: true }],
    };
  }
  window.zoltMockData = () => {
    const now = Date.now(),
      count = Math.min(500, Number(/chats=(\d+)/.exec(location.hash)?.[1] ?? 0));
    return count > 6 ? large(count, now) : small(new Date(now).toISOString());
  };
})();
