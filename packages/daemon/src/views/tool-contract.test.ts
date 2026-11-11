import { SessionTokens, startHostMcp, ToolDispatcher } from "@zoltbot/hostmcp";
import { expect, it } from "vitest";
import { callFixtureHost } from "../../../../tools/fakes/src/host-mcp-call.js";
import { viewToolFixture } from "./tool-fixture.js";
import { viewToolDefinition, viewToolHint } from "./tools.js";

it("validates full view tool inputs even when sessions receive a compact hint", async () => {
  const tokens = new SessionTokens();
  const token = tokens.issue({ agentId: "fixture", threadId: "fixture", sessionId: "fixture" });
  let calls = 0;
  const dispatcher = new ToolDispatcher(tokens, {
    tools: new Map([
      [
        "team_view",
        async () => {
          calls++;
          return { items: [] };
        },
      ],
    ]),
    authorize: () => true,
    checkLimits: () => true,
    audit: async () => {},
  });
  const server = await startHostMcp({
    tokens,
    dispatcher,
    tools: [viewToolDefinition],
    toolsForActor: () => [viewToolHint],
  });
  const call = (args: Record<string, unknown>) =>
    callFixtureHost(
      server.url,
      { Authorization: `Bearer ${token}` },
      { name: "team_view", arguments: args },
    );
  try {
    for (const args of [
      { action: "list", granted: ["act"] },
      { action: "save", id: "../outside" },
      { action: "save", source: { dir: "staged", granted: ["approve"] } },
      { action: "save", key: "x".repeat(101) },
    ])
      await expect(call(args)).rejects.toThrow("host_mcp_call_failed");
    expect(calls).toBe(0);
    await call({ action: "list" });
    expect(calls).toBe(1);
  } finally {
    await server.close();
  }
});
it("rejects saves outside the frozen staging folder", async () => {
  const f = await viewToolFixture();
  try {
    for (const dir of [
      "../outside",
      "/tmp/views",
      ".zoltbot/staging/not-a-uuid",
      ".zoltbot/staging/00000000-0000-4000-8000-000000000000/../outside",
    ]) {
      await expect(
        f.call({
          action: "save",
          id: "example",
          baseHash: f.context.store.record("view", "example")?.bundleHash,
          source: { dir },
          key: "scope",
        }),
      ).rejects.toThrow("view_staging_scope_denied");
    }
  } finally {
    await f.close();
  }
});
