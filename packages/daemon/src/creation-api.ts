import { isDeepStrictEqual } from "node:util";
import {
  applyEvents,
  createDirection,
  createScopedChat,
  handle,
  type Outcome,
} from "@zoltbot/core";
import {
  type AgentDefinition,
  AgentDefinitionSchema,
  type DomainEvent,
  experimentalProvidersEnabled,
  ProfileSchema,
  ProjectSchema,
  parse,
  SubprojectSchema,
  ThreadSchema,
  type UserInput,
} from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import { assertPublicDefinition } from "./definition-configuration.js";
import type { PrivateInputGuard } from "./private-input.js";

export function creationApi(host: {
  store: Store;
  privacy: PrivateInputGuard;
  publish(events: DomainEvent[]): void;
  definitions?(): Promise<{ definitions: AgentDefinition[] }>;
}) {
  return async (
    method: string,
    params: Record<string, unknown>,
    commandId?: string,
  ): Promise<unknown> => {
    const creations = {
      "agent.create": { kind: "agent", schema: ProfileSchema },
      "thread.create": { kind: "thread", schema: ThreadSchema },
      "project.create": { kind: "project", schema: ProjectSchema },
      "subproject.create": { kind: "subproject", schema: SubprojectSchema },
    } as const;
    if (!(method in creations)) return undefined;
    if (!commandId) throw new Error("command_id_required");
    const { kind, schema } = creations[method as keyof typeof creations];
    const value: Record<string, unknown> = structuredClone(parse(schema, params.value));
    if (kind === "thread" && value.fork) throw Error("fork_provenance_reserved");
    const replay = host.store.receipt(commandId);
    if (replay) {
      const events = host.store.eventsSince(replay.fromSeq - 1, replay.toSeq - replay.fromSeq + 1);
      if (
        !isDeepStrictEqual(replay.result, value) ||
        !events.some((event) => event.type === `${kind}.created` && event.aggregateId === value.id)
      )
        throw new Error("command_receipt_conflict");
      if (
        kind === "thread" &&
        value.kind === "manager" &&
        !events.some((event) => {
          const row = event.payload as Record<string, unknown>;
          const detail = row.detail as Record<string, unknown> | undefined;
          return (
            event.aggregateType === "audit" &&
            row.action === "manager.assign" &&
            row.target === value.id &&
            (row.actor as { kind?: string } | undefined)?.kind === "human" &&
            detail?.confirmed === true &&
            detail.profileId === value.agentId &&
            isDeepStrictEqual(detail.scope, value.node)
          );
        })
      )
        throw new Error("command_receipt_conflict");
      return replay.result;
    }
    let definition: AgentDefinition | undefined;
    if (kind === "agent") {
      const stored = host.store
        .snapshot(["agentDefinition"])
        .agentDefinition?.find((row) => row.id === value.definitionId);
      const selected =
        stored ??
        (await host.definitions?.())?.definitions.find((row) => row.id === value.definitionId);
      if (!selected) throw new Error("agent_definition_unavailable");
      definition = parse(AgentDefinitionSchema, selected);
      assertPublicDefinition(definition);
    }
    const publicText =
      kind === "agent"
        ? [value.name, value.avatar, value.instructions, value.roleText, value.model, value.effort]
        : kind === "thread"
          ? [value.title]
          : kind === "project"
            ? [
                value.name,
                value.goal,
                value.instructions,
                value.constraints,
                ...(value.roots as { path: string; label: string; repoRoot?: string }[]).flatMap(
                  (root) => [root.path, root.label, root.repoRoot],
                ),
              ]
            : [value.name, value.label, value.goal, value.instructions];
    const parts: UserInput = publicText
      .filter((text): text is string => typeof text === "string")
      .map((text) => ({ type: "text", text }));
    const checks = [await host.privacy.prepareInput(parts)];
    if (definition) checks.push(await host.privacy.prepareData(definition));
    const before = host.store.lastSeq();
    let produced = false;
    const receipt = host.store.dispatch(commandId, (initial) => {
      produced = true;
      for (const check of checks) check(initial);
      let state = initial;
      const events: DomainEvent[] = [];
      const context = {
        commandId,
        at: new Date().toISOString(),
        actor: { kind: "human" as const, id: "local-owner" },
      };
      if (definition) {
        if (
          definition.experimental &&
          !experimentalProvidersEnabled(
            state.settings?.find((row) => row.key === "providers.experimental")?.value,
          )
        )
          throw new Error("experimental_provider_disabled");
        const existing = state.agentDefinition?.find((row) => row.id === definition.id);
        if (existing && !isDeepStrictEqual(existing, definition))
          throw new Error("agent_definition_changed");
        if (!existing) {
          const registered = handle(
            state,
            { type: "create", kind: "agentDefinition", value: definition },
            { ...context, commandId: `${commandId}:definition` },
          );
          events.push(...registered.events);
          state = applyEvents(state, registered.events);
        }
      } else if (
        kind === "thread" &&
        !state.agent?.some((row) => row.id === value.agentId && !row.archived)
      )
        throw new Error("profile_unavailable");
      if (
        kind === "thread" &&
        value.projectId !== undefined &&
        !state.project?.some((row) => row.id === value.projectId && !row.archived)
      )
        throw new Error("project_unavailable");
      const scopedContext = { ...context, commandId: `${commandId}:${kind}` };
      const created =
        kind === "thread"
          ? createScopedChat(state, value, scopedContext, params.confirmed === true)
          : kind === "subproject"
            ? createDirection(state, value, scopedContext)
            : handle(state, { type: "create", kind, value }, scopedContext);
      return { events: [...events, ...created.events], result: created.result } satisfies Outcome;
    });
    if (!isDeepStrictEqual(receipt.result, value)) throw new Error("command_receipt_conflict");
    if (produced) host.publish(host.store.eventsSince(before));
    return receipt.result;
  };
}
