import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { acpDefinitions } from "../../../packages/adapters/acp/src/definitions.js";
import { AcpAdapter } from "../../../packages/adapters/acp/src/index.js";
import { claudeDefinitions } from "../../../packages/adapters/claude/src/definitions.js";
import { codexDefinitions } from "../../../packages/adapters/codex/src/definitions.js";
import type { AgentSession, OpenOptions } from "../../../packages/adapters/sdk/src/index.js";
import { Redactor } from "../../../packages/daemon/src/logging.js";
import { providerHosts } from "../../../packages/daemon/src/provider-hosts.js";
import type { AgentEvent } from "../../../packages/protocol/src/index.js";
import { hostMcpFixture } from "../../fakes/src/host-mcp-fixture.js";

/** Opt-in: native login, synthetic conversations and short billable turns; no desktop UI. */
export async function nativeForkCanary(provider: string) {
  const source =
    provider === "claude"
      ? claudeDefinitions[0]
      : provider === "codex"
        ? codexDefinitions[0]
        : acpDefinitions.find((d) => d.id === provider);
  if (!source) throw Error("canary_provider_unavailable");
  const root = await mkdtemp(path.join(tmpdir(), "zoltbot-native-fork-"));
  const parentHost = await hostMcpFixture(),
    childHost = await hostMcpFixture();
  const redactor = new Redactor([parentHost.token, childHost.token]);
  const hosts = providerHosts({
    directory: root,
    ...(provider === "grok"
      ? { overrides: () => ({ grok: path.resolve(".cache/spikes/grok-cli/grok") }) }
      : {}),
  });
  const definition = await hosts.definition(source);
  const adapter = hosts.adapters(redactor).get(source.adapter);
  if (!adapter) throw Error("canary_adapter_unavailable");
  if (adapter instanceof AcpAdapter && provider === "grok")
    adapter.flavors.get("grok").nativeFork = { route: "grok", versions: ["1.0.70"] };
  const sessions: AgentSession[] = [];
  const readers: Promise<void>[] = [];
  const streams = new Map<AgentSession, AgentEvent[]>();
  const attach = (s: AgentSession) => {
    sessions.push(s);
    const events: AgentEvent[] = [];
    streams.set(s, events);
    readers.push(
      (async () => {
        for await (const e of s.events()) {
          events.push(e);
          if (e.t === "interaction.requested")
            await s.respond(e.interaction.nativeRef ?? e.interaction.id, {
              action:
                e.interaction.type === "approval" &&
                JSON.stringify(e.interaction).includes("team_fixture_ping")
                  ? "accept"
                  : "cancel",
              choice: "allow_once",
              by: { kind: "system", id: "canary" },
              at: new Date().toISOString(),
            });
        }
      })(),
    );
    return s;
  };
  async function turn(s: AgentSession, text: string) {
    const events = streams.get(s) as AgentEvent[];
    const before = events.length;
    await s.send([{ type: "text", text }], "queue");
    const until = Date.now() + 90_000;
    while (!events.slice(before).some((e) => e.t === "turn.done")) {
      if (Date.now() > until) throw Error("canary_turn_timeout");
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    const done = events.slice(before).find((e) => e.t === "turn.done");
    if (done?.t !== "turn.done" || done.status !== "completed") throw Error("canary_turn_failed");
    return events
      .slice(before)
      .filter((e) => e.t === "message.done")
      .map((e) => (e.t === "message.done" ? e.text : ""))
      .join("\n");
  }
  const base: OpenOptions = {
    identity: { agentId: "test-profile", threadId: "test-thread" },
    mode: "new",
    cwd: root,
    permissionProfile: "read_only",
    hostMcp: { url: parentHost.url, token: parentHost.token },
  };
  try {
    const parent = attach(await adapter.open(definition, base));
    await turn(
      parent,
      "Remember the marker PARENT_FORK_SEED_481. Reply with that marker only. Do not use tools.",
    );
    await turn(
      parent,
      "Also remember SECOND_PARENT_MARKER_729. Reply with that marker only. Do not use tools.",
    );
    const original = parent.nativeId;
    if (!original) throw Error("canary_parent_identity_missing");
    const childOptions: OpenOptions = {
      ...base,
      mode: "fork",
      fork: {
        sourceNativeId: original,
        sourceCwd: root,
        targetNativeId: crypto.randomUUID(),
        boundary: { kind: "latest" },
      },
      hostMcp: { url: childHost.url, token: childHost.token },
    };
    const child = attach(await adapter.open(definition, childOptions));
    if (!child.nativeId || child.nativeId === original)
      throw Error("canary_child_identity_mismatch");
    if ((streams.get(child) ?? []).some((e) => e.t === "turn.started"))
      throw Error("canary_fork_started_model_turn");
    const reply = await turn(
      child,
      "Call team_fixture_ping exactly once, then reply with both markers from the previous conversation. Also remember CHILD_ONLY_MARKER_963. Do not read files or run commands.",
    );
    if (!reply.includes("PARENT_FORK_SEED_481") || !reply.includes("SECOND_PARENT_MARKER_729"))
      throw Error("canary_history_missing");
    childHost.assertCalled();
    const childId = child.nativeId;
    await child.close();
    const { fork: _fork, ...resumeOptions } = childOptions;
    const resumed = attach(
      await adapter.open(definition, {
        ...resumeOptions,
        mode: "resume",
        nativeId: childId,
      }),
    );
    if (resumed.nativeId !== childId) throw Error("canary_child_resume_identity");
    const resumedReply = await turn(
      resumed,
      "Reply with all markers from this conversation. Do not use tools.",
    );
    if (!resumedReply.includes("CHILD_ONLY_MARKER_963")) throw Error("canary_child_resume_history");
    await parent.close();
    const resumedParent = attach(
      await adapter.open(definition, { ...base, mode: "resume", nativeId: original }),
    );
    const originalReply = await turn(
      resumedParent,
      "Reply with all markers from this conversation. Do not use tools.",
    );
    if (
      !originalReply.includes("PARENT_FORK_SEED_481") ||
      originalReply.includes("CHILD_ONLY_MARKER_963") ||
      resumedParent.nativeId !== original
    )
      throw Error("canary_source_changed");
    return {
      provider,
      nativeFork: true,
      sourceTurns: 2,
      independentResumeHistory: true,
      independentIdentity: true,
      inheritedHistory: true,
      childHostRebound: true,
      childResume: true,
      sourceUnchanged: true,
    };
  } finally {
    await Promise.allSettled(sessions.map((s) => s.close()));
    await Promise.allSettled(readers);
    await parentHost.close();
    await childHost.close();
    await hosts.close();
    await rm(root, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  nativeForkCanary(process.argv[2] ?? "")
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      const code =
        error instanceof Error &&
        (/^canary_[a-z_]+$/.test(error.message) ||
          ["auth_required", "host_mcp_call_not_verified", "unsupported_fork"].includes(
            error.message,
          ))
          ? error.message
          : "native_fork_canary_failed";
      process.stderr.write(`${code}\n`);
      process.exitCode = 1;
    });
}
