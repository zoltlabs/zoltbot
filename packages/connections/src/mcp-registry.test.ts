import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { mcpRegistryClient, publisherOf } from "./mcp-registry.js";

const fixture = readFileSync(
  new URL("./fixtures/mcp-registry-search.json", import.meta.url),
  "utf8",
);

function client(now = { value: 0 }) {
  const fetch = vi.fn(async (_url: string) => JSON.parse(fixture) as unknown);
  return {
    fetch,
    registry: mcpRegistryClient({
      get: fetch,
      now: () => now.value,
    }),
  };
}

describe("MCP registry", () => {
  it("searches the latest versions and reads each kind of install", async () => {
    const { fetch, registry } = client();
    const servers = await registry.search("notes");
    const url = new URL(String(fetch.mock.calls[0]?.[0]));
    expect(url.pathname).toBe("/v0/servers");
    expect(url.searchParams.get("search")).toBe("notes");
    expect(url.searchParams.get("version")).toBe("latest");
    const byId = new Map(servers.map((server) => [server.id, server]));
    expect(byId.get("com.example/notes")).toMatchObject({
      title: "Example Notes",
      publisher: { kind: "domain", name: "example.com" },
      repository: "https://github.com/example/notes-mcp",
      install: { kind: "remote", url: "https://mcp.example.com/mcp", headers: [] },
    });
    expect(byId.get("io.github.acme/issues")).toMatchObject({
      publisher: { kind: "github", name: "acme" },
      install: {
        kind: "package",
        command: ["npx", "-y", "@acme/issues-mcp@0.3.1"],
        env: [{ name: "ACME_TOKEN", required: true, secret: true }],
      },
    });
    expect(byId.get("io.github.someone/weather")?.install).toMatchObject({
      command: ["uvx", "weather-mcp==2.0.0"],
    });
    expect(byId.get("ai.smithery/Hint-Services-obsidian-github-mcp")?.install).toMatchObject({
      kind: "remote",
      headers: [{ name: "Authorization", required: true, secret: true }],
    });
  });

  it("leaves out deprecated servers and can't build a command from odd package names", async () => {
    const { registry } = client();
    const servers = await registry.search("anything");
    expect(servers.some((server) => server.id === "io.github.old/thing")).toBe(false);
    expect(servers.find((server) => server.id === "io.github.docker/only")?.install).toEqual({
      kind: "unsupported",
    });
    expect(servers.find((server) => server.id === "io.github.evil/inject")?.install).toEqual({
      kind: "unsupported",
    });
  });

  it("keeps results for an hour and finds a server by id from the cache", async () => {
    const now = { value: 0 };
    const { fetch, registry } = client(now);
    await registry.search("Notes ");
    await registry.search("notes");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await registry.find("com.example/notes"))?.version).toBe("1.4.0");
    expect(fetch).toHaveBeenCalledTimes(1);
    now.value = 61 * 60 * 1000;
    await registry.search("notes");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("lists the newest servers for a query too short to search", async () => {
    const { fetch, registry } = client();
    await registry.search("ab");
    expect(new URL(String(fetch.mock.calls[0]?.[0])).searchParams.has("search")).toBe(false);
  });

  it("names publishers by what the registry checked", () => {
    expect(publisherOf("io.github.acme/x")).toEqual({ kind: "github", name: "acme" });
    expect(publisherOf("com.example.mcp/x")).toEqual({ kind: "domain", name: "mcp.example.com" });
  });
});
