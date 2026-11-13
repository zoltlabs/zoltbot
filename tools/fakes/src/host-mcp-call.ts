import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/** Synthetic native providers consume the same injected URL and headers as their real route. */
export async function callFixtureHost(
  url: string,
  headers: Record<string, string>,
  request = { name: "team_fixture_ping", arguments: {} as Record<string, unknown> },
): Promise<string> {
  const resolved = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_match, name: string) => process.env[name] ?? ""),
    ]),
  );
  const client = new Client({ name: "zoltbot-synthetic-native", version: "1" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: resolved },
      }),
    );
    const tools = await client.listTools();
    // Manager sessions expose organization shaping through the company facade.
    // Follow the advertised surface, as a real model does, while keeping legacy fixtures useful.
    if (
      request.name === "workspace_write" &&
      !tools.tools.some((tool) => tool.name === request.name) &&
      tools.tools.some((tool) => tool.name === "company_work")
    ) {
      const { action, key, ...body } = request.arguments;
      request = { name: "company_work", arguments: { action, key, request: body } };
    }
    if (!tools.tools.some((tool) => tool.name === request.name))
      throw new Error("host_mcp_tool_missing");
    const result = await client.callTool(request);
    if (result.isError) throw new Error("host_mcp_call_failed");
    return JSON.stringify(result);
  } finally {
    await client.close();
  }
}

/** D119 prompts that make a synthetic provider shape the workspace through the host route. */
export const workspaceRequests: Record<
  string,
  { name: string; arguments: Record<string, unknown> }
> = {
  workspace_area: {
    name: "workspace_write",
    arguments: {
      action: "create",
      key: "growth",
      kind: "subproject",
      name: "Growth",
      parent: { type: "project", id: "zolt" },
    },
  },
  workspace_project: {
    name: "workspace_write",
    arguments: { action: "create", key: "coach", kind: "project", name: "Coach" },
  },
};

for (const [prompt, text] of [
  ["artifact_page", "<h1>Artifact version one</h1>"],
  ["artifact_page_v2", "<h1>Artifact version two</h1>"],
] as const)
  workspaceRequests[prompt] = {
    name: "team_artifact",
    arguments: {
      action: "save",
      key: "provider-page",
      kind: "page",
      title: "Provider page",
      source: { files: [{ path: "index.html", text }] },
    },
  };

/** Synthetic providers select their scenario while preserving real injected target blocks on the wire. */
export function artifactFixturePrompt(blocks: string[]): string {
  // Real task prompts include their brief/review framing. Only explicit test markers
  // select a cloud scenario; ordinary task prose keeps its existing behavior.
  const cloud = blocks.join("\n").match(/^\[cloud-m1:(mac_exec|question|slow|hang)\]$/m)?.[1];
  if (cloud) return cloud;
  if (!blocks.some((text) => text.includes("[brief:human-artifact-target]")))
    return blocks.at(-1) ?? "";
  return (
    blocks.flatMap((text) => text.split("\n")).find((text) => text in workspaceRequests) ??
    blocks.at(-1) ??
    ""
  );
}

export async function openFixtureMcp(url: string, token: string) {
  const client = new Client({ name: "event-fixture", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}
