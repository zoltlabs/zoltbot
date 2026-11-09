import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { acpDefinitions } from "../../../packages/adapters/acp/src/index.js";
import type { AgentSession } from "../../../packages/adapters/sdk/src/index.js";
import { Redactor } from "../../../packages/daemon/src/logging.js";
import { providerHosts } from "../../../packages/daemon/src/provider-hosts.js";
import type { AgentEvent } from "../../../packages/protocol/src/index.js";
import { hostMcpFixture } from "../../fakes/src/host-mcp-fixture.js";

/** Explicit opt-in only: uses native credentials and two short billable turns in a disposable folder. */
export async function runAcpCanary(provider: string, binary?: string) {
  const source = acpDefinitions.find((entry) => entry.id === provider);
  if (!source || !["cursor", "antigravity", "opencode", "copilot"].includes(provider))
    throw new Error("unknown_canary_provider");
  const directory = await mkdtemp(path.join(tmpdir(), "zoltbot-canary-"));
  const hosts = providerHosts({
    directory,
    ...(binary ? { resolve: async () => path.resolve(binary) } : {}),
  });
  let session: AgentSession | undefined;
  const mcp = await hostMcpFixture();
  const redactor = new Redactor([mcp.token]);
  const trace: AgentEvent[] = [];
  const readers: Promise<void>[] = [];
  const consume = (native: AgentSession) =>
    readers.push(
      (async () => {
        for await (const event of native.events()) {
          trace.push(event);
          if (event.t === "interaction.requested")
            await native.respond(event.interaction.nativeRef ?? event.interaction.id, {
              action:
                event.interaction.type === "approval" &&
                JSON.stringify(event.interaction).includes("team_fixture_ping")
                  ? "accept"
                  : "cancel",
              choice: "allow_once",
              by: { kind: "system", id: "canary" },
              at: new Date().toISOString(),
            });
        }
      })(),
    );
  const completed = async (count: number) => {
    const until = Date.now() + 90000;
    while (Date.now() < until) {
      if (trace.some((event) => event.t === "status" && event.state === "error"))
        throw new Error("canary_provider_error");
      const turns = trace.filter((event) => event.t === "turn.done");
      if (turns.some((event) => event.t === "turn.done" && event.status !== "completed"))
        throw new Error("canary_turn_failed");
      if (turns.length >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("canary_timeout");
  };
  try {
    const definition = await hosts.definition(source);
    const key = source.auth?.apiKeyEnv;
    if (key && process.env[key]) {
      const value = process.env[key] as string;
      redactor.register(value);
      redactor.hideFrames();
      definition.launch.env[key] = value;
    }
    const adapter = hosts.adapters(redactor).get("acp");
    if (!adapter) throw new Error("missing_acp_adapter");
    const options = {
      identity: { agentId: "test-profile", threadId: "test-thread" },
      mode: "new" as const,
      cwd: directory,
      permissionProfile: "workspace_write" as const,
      hostMcp: { url: mcp.url, token: mcp.token },
    };
    session = await adapter.open(definition, options);
    consume(session);
    await session.send(
      [
        {
          type: "text",
          text: "Call the Zoltbot MCP tool team_fixture_ping exactly once, then reply ZOLTBOT_CANARY_OK. Do not read or modify any files or execute commands.",
        },
      ],
      "queue",
    );
    await completed(1);
    mcp.assertCalled();
    const nativeId = session.nativeId;
    if (!nativeId || !session.capabilities.resume) throw new Error("canary_resume_unavailable");
    await session.close();
    const resumedAt = trace.length;
    session = await adapter.open(definition, { ...options, mode: "resume", nativeId });
    consume(session);
    await session.send(
      [
        {
          type: "text",
          text: "Reply with the exact marker you used in your previous reply. Do not use tools.",
        },
      ],
      "queue",
    );
    await completed(2);
    if (
      !trace
        .slice(resumedAt)
        .some((event) => event.t === "message.done" && event.text.includes("ZOLTBOT_CANARY_OK"))
    )
      throw new Error("canary_marker_missing");
    return {
      provider,
      version: trace.find((event) => event.t === "session.ready")?.providerVersion,
      hostTools: true,
      resume: true,
    };
  } finally {
    await session?.close();
    await hosts.close();
    await mcp.close();
    await Promise.all(readers);
    await rm(directory, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv.includes("--authenticated"))
    throw new Error("authenticated_canary_opt_in_required");
  try {
    console.log(
      JSON.stringify(
        await runAcpCanary(
          process.argv[2] ?? "",
          process.argv[3] === "--authenticated" ? undefined : process.argv[3],
        ),
      ),
    );
  } catch (error) {
    const code =
      error instanceof Error &&
      [
        "auth_required",
        "http_mcp_not_supported",
        "unsupported_acp_version",
        "canary_resume_unavailable",
        "canary_timeout",
        "canary_provider_error",
        "canary_turn_failed",
        "canary_marker_missing",
        "host_mcp_call_not_verified",
      ].includes(error.message)
        ? error.message
        : "canary_failed";
    console.error(`ACP canary: ${code}`);
    console.error(
      "Authenticated ACP canary failed. Verify the CLI version, native sign-in, and account quota. No credentials or conversation content were printed.",
    );
    process.exitCode = 1;
  }
}
