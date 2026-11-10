import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { referenceTokenEstimate } from "@zoltbot/adapters-sdk/tokens";
import { expect, it } from "vitest";
import { createArtifactBinding } from "./artifacts/binding.js";
import { browserBinding, browserGuidance } from "./browser/runtime.js";
import {
  artifactBrowserToolDefinitions,
  artifactRuntimeToolDefinitions,
  browserRuntimeToolDefinitions,
  indirectRuntimeToolDefinitions,
  managerArtifactBrowserToolDefinitions,
  managerArtifactToolDefinitions,
  runtimeToolDefinitions,
} from "./runtime-tools.js";

it("keeps every direct host tool surface within eight tools and 700 description tokens", () => {
  for (const tools of [
    runtimeToolDefinitions,
    browserRuntimeToolDefinitions,
    artifactRuntimeToolDefinitions,
    artifactBrowserToolDefinitions,
    managerArtifactToolDefinitions,
    managerArtifactBrowserToolDefinitions,
  ]) {
    expect(new Set(tools.map((tool) => tool.name)).size).toBe(tools.length);
    expect(tools.length).toBeLessThanOrEqual(8);
    expect(
      referenceTokenEstimate(tools.map((tool) => tool.description).join("\n")),
    ).toBeLessThanOrEqual(700);
  }
});

it("fits artifact plus browser guidance and the compact frozen schemas inside 1500 tokens", () => {
  mkdirSync(".cache/tests", { recursive: true });
  const root = mkdtempSync(path.resolve(".cache/tests/artifact-budget-"));
  try {
    const artifact = createArtifactBinding(root);
    const installedArtifact = createArtifactBinding(
      path.join(
        root,
        "installed-app-trial",
        "data",
        "workspaces",
        "950d0c138bd16a7ab7286e6ad38edd832b3e90f3fda75b1969c88dae1d8d0af9",
      ),
    );
    expect(
      referenceTokenEstimate(
        JSON.stringify([...artifactRuntimeToolDefinitions, ...indirectRuntimeToolDefinitions]),
      ) +
        referenceTokenEstimate(installedArtifact.guidanceText) +
        32,
    ).toBeLessThanOrEqual(1500);
    expect(
      referenceTokenEstimate(
        JSON.stringify([...managerArtifactToolDefinitions, ...indirectRuntimeToolDefinitions]),
      ) +
        referenceTokenEstimate(installedArtifact.guidanceText) +
        32,
    ).toBeLessThanOrEqual(1500);
    const browser = browserBinding(root, root, { mode: "background" });
    expect(
      referenceTokenEstimate(
        JSON.stringify([...artifactRuntimeToolDefinitions, ...indirectRuntimeToolDefinitions]),
      ) + referenceTokenEstimate(artifact.guidanceText),
    ).toBeLessThanOrEqual(1500);
    expect(
      referenceTokenEstimate(JSON.stringify(artifactBrowserToolDefinitions)) +
        referenceTokenEstimate(artifact.guidanceText) +
        referenceTokenEstimate(browserGuidance(browser)),
    ).toBeLessThanOrEqual(1500);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("retains full server validation even when frozen tool hints omit repeated bounds", async () => {
  const { SessionTokens, startHostMcp, ToolDispatcher } = await import("@zoltbot/hostmcp");
  const { callFixtureHost } = await import("../../../tools/fakes/src/host-mcp-call.js");
  const { allRuntimeToolDefinitions } = await import("./runtime-tools.js");
  const tokens = new SessionTokens();
  const token = tokens.issue({ agentId: "fixture", threadId: "fixture", sessionId: "fixture" });
  let calls = 0;
  const dispatcher = new ToolDispatcher(tokens, {
    tools: new Map([
      [
        "workspace_write",
        async () => {
          calls++;
          return { ok: true };
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
    tools: allRuntimeToolDefinitions,
    toolsForActor: () => artifactBrowserToolDefinitions,
  });
  try {
    await expect(
      callFixtureHost(
        server.url,
        { Authorization: `Bearer ${token}` },
        {
          name: "workspace_write",
          arguments: { action: "create", key: "fixture", kind: "project", name: "x".repeat(151) },
        },
      ),
    ).rejects.toThrow("host_mcp_call_failed");
    expect(calls).toBe(0);
    await expect(
      callFixtureHost(
        server.url,
        { Authorization: `Bearer ${token}` },
        {
          name: "workspace_write",
          arguments: {
            action: "create",
            key: "fixture",
            kind: "project",
            name: "Test",
            unexpected: true,
          },
        },
      ),
    ).rejects.toThrow("host_mcp_call_failed");
    expect(calls).toBe(0);
  } finally {
    await server.close();
  }
});
