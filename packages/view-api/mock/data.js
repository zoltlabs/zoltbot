(() => {
  window.zoltMockData = () => {
    const at = new Date().toISOString();
    const chat = (id, title, status, workspaceId) => ({
      id,
      title,
      kind: "main",
      status,
      profile: { id: "builder", name: "Builder" },
      provider: { id: "demo", name: "Demo agent" },
      workspaceId,
      worktree: { id: `tree-${workspaceId}`, kind: "folder" },
      requestIds: [],
      startedAt: at,
      updatedAt: at,
      usage: { costUsd: 0.04, inputTokens: 300, outputTokens: 100 },
    });
    const chats = [
      chat("demo-build", "Build the page", "working", "demo-app"),
      chat("demo-check", "Check the result", "needs_you", "demo-app"),
      chat("demo-notes", "Write the notes", "idle", "demo-docs"),
    ];
    chats[1].requestIds = ["demo-request"];
    return {
      chats,
      requests: [
        {
          id: "demo-request",
          version: 1,
          chatId: "demo-check",
          type: "approval",
          title: "Run the checks?",
          urgency: "blocking",
          createdAt: at,
          context: { command: "pnpm test" },
          choices: [
            { id: "allow_once", label: "Allow once", widens: false },
            { id: "allow_session", label: "Allow for this session", widens: true },
            { id: "reject_once", label: "Reject once", widens: false },
          ],
        },
      ],
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
  };
})();
