import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";
import type { ConformanceFactory, Scenario } from "@zoltbot/adapters-sdk/conformance";
import { runConformance, scenarios } from "@zoltbot/adapters-sdk/conformance";
import type { AgentDefinition, AgentEvent } from "@zoltbot/protocol";
import { describe, expect, it } from "vitest";
import { ReferenceAdapter } from "./reference-adapter.js";

const definition: AgentDefinition = {
  id: "reference",
  displayName: "Reference",
  adapter: "reference",
  binaryNames: ["node"],
  versionCommand: ["--version"],
  launch: { command: "node", args: [], env: {} },
  testedVersions: "test-1",
  defaults: { permissionProfile: "workspace_write" },
  staticCapabilities: {},
  nativeSessionRoots: [],
  experimental: false,
};
async function host(): Promise<{ server: Server; url: string; token: string }> {
  const token = randomBytes(24).toString("hex");
  const server = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401);
      response.end("denied");
      return;
    }
    response.end("scoped-host-ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("bad address");
  return { server, token, url: `http://127.0.0.1:${address.port}/mcp` };
}
const factory =
  (broken?: "drop_final" | "drop_interactions" | "drop_question_other"): ConformanceFactory =>
  async (scenario: Scenario) => {
    mkdirSync(".cache/test-results/conformance", { recursive: true });
    const cwd = mkdtempSync(path.resolve(`.cache/test-results/conformance/${scenario}-`));
    const endpoint = await host();
    const adapter = new ReferenceAdapter(broken);
    const options = {
      mode: "new" as const,
      cwd,
      permissionProfile: "workspace_write" as const,
      identity: { agentId: "test-agent", threadId: "test-thread" },
      hostMcp: { url: endpoint.url, token: endpoint.token },
    };
    const session = await adapter.open(definition, options);
    const sessions = [session];
    const trace: AgentEvent[] = [];
    const consume = async (s: typeof session) => {
      for await (const event of s.events()) trace.push(event);
    };
    void consume(session);
    return {
      session,
      trace,
      reopen: async (nativeId: string) => {
        const s = await adapter.open(definition, { ...options, mode: "resume", nativeId });
        sessions.push(s);
        void consume(s);
        return s;
      },
      frameLog: () => session.frameLog(),
      childEnvironment: () => session.environment(),
      dispose: async () => {
        for (const s of sessions) await s.close();
        await new Promise<void>((resolve) => endpoint.server.close(() => resolve()));
      },
    };
  };
describe("shared normalized conformance suite", () => {
  for (const scenario of scenarios) it(scenario, () => runConformance(factory(), scenario));
  it("rejects an adapter that drops authoritative final messages", async () => {
    await expect(runConformance(factory("drop_final"), "stream")).rejects.toThrow(
      /authoritative final/,
    );
  });
  it("rejects an adapter that loses approval requests", async () => {
    await expect(runConformance(factory("drop_interactions"), "approve")).rejects.toThrow(
      /event deadline/,
    );
  });
  it("rejects a provider that drops advertised free text question support", async () => {
    await expect(runConformance(factory("drop_question_other"), "question")).rejects.toThrow(
      "free text support missing",
    );
  });
});
