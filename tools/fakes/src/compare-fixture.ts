import { handle } from "@zoltbot/core";
import { AgentDefinitionSchema, ProfileSchema, parse } from "@zoltbot/protocol";
import { startDaemon } from "../../../packages/daemon/src/api.js";
import { CompareFakeSession } from "./compare-runtime.js";
import { at, runtimeFixture } from "./runtime-fixture.js";
export async function compareFixture(
  options: {
    longFirst?: boolean;
    secrets?: import("../../../packages/daemon/src/api.js").DaemonOptions["secrets"];
  } = {},
) {
  const f = await runtimeFixture("zoltbot.db");
  const context = (commandId: string) => ({
    commandId,
    at,
    actor: { kind: "human" as const, id: "owner" },
  });
  const update = (
    kind: "agentDefinition" | "agent",
    id: string,
    changes: Record<string, unknown>,
  ) => {
    const key = `fixture-update:${id}`;
    f.store.dispatch(key, (state) =>
      handle(state, { type: "update", kind, id, changes, confirmed: true }, context(key)),
    );
  };
  update("agentDefinition", "fake", { staticCapabilities: { readOnly: true } });
  update("agent", "profile", { name: "First", permissionProfile: "workspace_write" });
  const profile = parse(ProfileSchema, f.store.record("agent", "profile"));
  const definition = parse(AgentDefinitionSchema, f.store.record("agentDefinition", "fake"));
  f.store.dispatch("unavailable-definition", (state) =>
    handle(
      state,
      {
        type: "create",
        kind: "agentDefinition",
        value: {
          ...definition,
          id: "unavailable",
          displayName: "Unavailable tool",
          staticCapabilities: { readOnly: false },
        },
      },
      context("unavailable-definition"),
    ),
  );
  for (const [id, name] of [
    ["second", "Second"],
    ["third", "Third"],
    ["fourth", "Fourth"],
    ["unavailable", "Unavailable"],
  ]) {
    const key = `profile:${id}`;
    f.store.dispatch(key, (state) =>
      handle(
        state,
        {
          type: "create",
          kind: "agent",
          value: {
            ...profile,
            id,
            name,
            ...(id === "unavailable" ? { definitionId: "unavailable" } : {}),
          },
        },
        context(key),
      ),
    );
  }
  f.store.close();
  const natives = new Map<string, CompareFakeSession>(),
    permissions: string[] = [];
  const daemon = await startDaemon({
    dataDir: f.root,
    ...(options.secrets ? { secrets: options.secrets } : {}),
    origins: ["http://127.0.0.1:5196"],
    runtimeHost: {
      async prepare(input) {
        permissions.push(input.profile.permissionProfile);
        return {
          cwd: f.root,
          estimate: (text) => text.length,
          fixedInjectedTokens: 0,
          async open() {
            const native = new CompareFakeSession(
              input.thread.id,
              input.profile.id === "profile" ? 200 : 1800,
              false,
              { threadId: input.thread.id, profileId: input.profile.id },
              input.thread.title.startsWith("Where they differ")
                ? "**Agree:** Both answers propose a bounded plan.\n\n**Differ:** Their order differs.\n\n**Only First:** Start small.\n\n**Only Second:** Review the result."
                : options.longFirst && input.profile.id === "profile"
                  ? "x".repeat(30000)
                  : `${input.profile.name} answer`,
            );
            natives.set(input.thread.id, native);
            return native;
          },
        };
      },
    },
  });
  return {
    daemon,
    natives,
    permissions,
    async close() {
      await daemon.close();
      f.close();
    },
  };
}
