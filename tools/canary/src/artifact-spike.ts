import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { acpDefinitions } from "../../../packages/adapters/acp/src/definitions.js";
import { claudeDefinitions } from "../../../packages/adapters/claude/src/definitions.js";
import { codexDefinitions } from "../../../packages/adapters/codex/src/definitions.js";
import type { AgentSession, OpenOptions } from "../../../packages/adapters/sdk/src/index.js";
import { Redactor } from "../../../packages/daemon/src/logging.js";
import { providerHosts } from "../../../packages/daemon/src/provider-hosts.js";
import {
  SessionTokens,
  startHostMcp,
  ToolDispatcher,
} from "../../../packages/hostmcp/src/index.js";

// Live providers, synthetic intake tool: this proves transport/permissions, not product saving.
const directory = path.resolve(".cache/artifacts-spike/matrix");
mkdirSync(directory, { recursive: true });
const hosts = providerHosts({ directory });
const tokens = new SessionTokens();
const receipts: { provider: string; profile: string; source: string; saved: boolean }[] = [];
let staging = "";
let saved = false;
let source = "";
const dispatcher = new ToolDispatcher(tokens, {
  tools: new Map([
    [
      "team_artifact",
      async (call) => {
        const args = call.arguments as { action: string; text?: string; dir?: string };
        if (args.action !== "save") throw Error("save_required");
        source = args.text ? "inline" : "staging";
        const html = args.text ?? readFileSync(path.join(staging, "index.html"), "utf8");
        if (html !== "<!doctype html><title>S16</title><h1>S16</h1>")
          throw Error("fixture_mismatch");
        if (args.dir && args.dir !== staging) throw Error("fixture_scope_denied");
        rmSync(staging, { recursive: true, force: true });
        saved = true;
        return { saved: true, fixture: true, version: 1 };
      },
    ],
  ]),
  authorize: () => true,
  checkLimits: () => true,
  audit: async () => {},
});
const mcp = await startHostMcp({
  tokens,
  dispatcher,
  tools: [
    {
      name: "team_artifact",
      description: "S16 synthetic intake. Save fixture HTML from staging or inline text.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["save"] },
          text: { type: "string" },
          dir: { type: "string" },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
  ],
});
let native: AgentSession | undefined;
try {
  const selected = process.argv[2] ?? "claude";
  const definition =
    selected === "claude"
      ? claudeDefinitions[0]
      : selected === "codex"
        ? codexDefinitions[0]
        : acpDefinitions.find((d) => d.id === selected);
  if (!definition) throw Error("unknown_provider");
  const resolved = await hosts.definition(definition);
  const redactor = new Redactor();
  const adapter = hosts.adapters(redactor).get(definition.adapter);
  if (!adapter) throw Error("adapter_missing");
  const profiles: OpenOptions["permissionProfile"][] =
    selected === "claude" || selected === "codex"
      ? ["workspace_write", "read_only"]
      : ["read_only"];
  for (const profile of profiles) {
    saved = false;
    source = "";
    const cwd = path.join(directory, selected, profile);
    mkdirSync(cwd, { recursive: true });
    staging = path.join(cwd, ".zoltbot", "staging", `s16-${profile}`);
    const token = tokens.issue({
      agentId: "s16",
      threadId: profile,
      sessionId: `${selected}-${profile}`,
    });
    redactor.register(token);
    native = await adapter.open(resolved, {
      identity: { agentId: "s16", threadId: profile },
      mode: "new",
      cwd,
      permissionProfile: profile,
      hostMcp: { url: mcp.url, token },
    });
    let complete!: () => void;
    const done = new Promise<void>((r) => {
      complete = r;
    });
    const session = native;
    const reader = (async () => {
      for await (const event of session.events()) {
        if (event.t === "interaction.requested")
          await session.respond(event.interaction.nativeRef ?? event.interaction.id, {
            action: "accept",
            ...(event.interaction.type === "form"
              ? { answers: { form: { value: {} } } }
              : { choice: "allow_once" }),
            by: { kind: "human", id: "s16-authorized-fixture" },
            at: new Date().toISOString(),
          });
        if (event.t === "turn.done") complete();
      }
    })();
    const html = "<!doctype html><title>S16</title><h1>S16</h1>";
    const instruction =
      profile === "read_only"
        ? `Do not write files. Call team_artifact with action save and text exactly ${JSON.stringify(html)}.`
        : `Create ${staging}/index.html containing exactly ${JSON.stringify(html)} (no newline). Then call team_artifact with action save and dir ${JSON.stringify(staging)}. This is a disposable local fixture; do not change any other file.`;
    await native.send([{ type: "text", text: instruction }], "queue");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        done,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error("s16_timeout")), 120000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    receipts.push({ provider: selected, profile, source, saved });
    writeFileSync(path.join(directory, `${selected}.json`), JSON.stringify(receipts, null, 2));
    await native.close();
    await reader;
    native = undefined;
    tokens.revoke(`${selected}-${profile}`);
    if (!saved) throw Error("save_not_observed");
  }
  console.log(JSON.stringify(receipts));
} finally {
  await native?.close();
  await hosts.close();
  await mcp.close();
}
