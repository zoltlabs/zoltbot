import { SessionTokens, startHostMcp, ToolDispatcher } from "@zoltbot/hostmcp";

export async function hostMcpFixture() {
  const tokens = new SessionTokens();
  const token = tokens.issue({
    agentId: "test-profile",
    threadId: "test-thread",
    sessionId: "test-session",
  });
  let calls = 0;
  const outcomes: string[] = [];
  const dispatcher = new ToolDispatcher(tokens, {
    tools: new Map([
      [
        "team_fixture_ping",
        async () => {
          calls++;
          return { text: "scoped-host-ok" };
        },
      ],
    ]),
    authorize: (actor) => actor.agentId === "test-profile" && actor.threadId === "test-thread",
    checkLimits: () => true,
    audit: async (record) => {
      outcomes.push(record.result);
    },
  });
  const host = await startHostMcp({
    tokens,
    dispatcher,
    tools: [
      {
        name: "team_fixture_ping",
        description: "Synthetic scoped transport proof.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
    ],
  });
  return {
    url: host.url,
    token,
    close: () => host.close(),
    assertCalled() {
      if (calls !== 1 || JSON.stringify(outcomes) !== '["started","succeeded"]')
        throw new Error("host_mcp_call_not_verified");
    },
  };
}
