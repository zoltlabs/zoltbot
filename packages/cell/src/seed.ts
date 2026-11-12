import { type CommandContext, handle } from "@zoltbot/core";
import { AgentDefinitionSchema, type DomainEvent, parse } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store/portable";
import claude from "../../adapters/claude/definitions/claude.json" with { type: "json" };
import codex from "../../adapters/codex/definitions/codex.json" with { type: "json" };

/** Share the adapter's data definitions without importing its Node process code. */
export function seedCell(store: Store) {
  const commandId = "cell:configuration:v1";
  if (store.receipt(commandId)) return;
  const context: CommandContext = {
    commandId,
    at: new Date().toISOString(),
    actor: { kind: "system", id: "cell" },
  };
  store.dispatch(
    commandId,
    () => {
      const events: DomainEvent[] = [];
      for (const source of [claude, codex]) {
        const definition = parse(AgentDefinitionSchema, { ...source, nativeSessionRoots: [] });
        for (const [kind, value] of [
          ["agentDefinition", definition],
          [
            "agent",
            {
              id: `cloud-${definition.id}`,
              name: definition.displayName,
              avatar: "",
              kind: "profile",
              definitionId: definition.id,
              permissionProfile: "workspace_write",
              instructions: "",
              hidden: false,
              archived: false,
              createdAt: context.at,
            },
          ],
        ] as const) {
          const output = handle({}, { type: "create", kind, value }, context);
          events.push(
            ...output.events.map((event) => ({
              ...event,
              eventId: `${commandId}:${events.length}`,
            })),
          );
        }
      }
      return { events, result: { ok: true } };
    },
    { scope: { projectId: "cell:configuration" }, kinds: [] },
  );
}
