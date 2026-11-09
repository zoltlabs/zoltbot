import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  compareGroup,
  compareMembers,
  compareSummaryPrompt,
  createCompare,
  createCompareDifferences,
  resolveCompare,
  sendCompare,
  voteCompare,
  widenCompare,
} from "@zoltbot/core";
import {
  compareMethods,
  type DomainEvent,
  type OutputMode,
  parse,
  type UserInput,
} from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import type { PrivateInputGuard } from "./private-input.js";

export function compareApi(host: {
  store: Store;
  privacy: PrivateInputGuard;
  publish(events: DomainEvent[]): void;
  wake(threadId: string): Promise<void>;
  definitions?:
    | (() => Promise<{ definitions: import("@zoltbot/protocol").AgentDefinition[] }>)
    | undefined;
}) {
  return async (
    method: string,
    raw: Record<string, unknown>,
    commandId?: string,
  ): Promise<unknown> => {
    if (!(method in compareMethods)) return undefined;
    const params = structuredClone(
      parse(compareMethods[method as keyof typeof compareMethods].params, raw),
    ) as Record<string, unknown>;
    if (method === "compare.list") {
      const rows = host.store.snapshot(["compare"]).compare ?? [];
      return {
        items: rows.filter(
          (row) =>
            (!params.projectId || row.projectId === params.projectId) &&
            (!params.node || isDeepStrictEqual(params.node, row.node)),
        ),
      };
    }
    if (method === "compare.get") {
      const state = host.store.snapshot(),
        id = String(params.id);
      const members = compareMembers(state, id);
      return {
        compare: compareGroup(state, id),
        members: members.map((member) => {
          const thread = state.thread?.find((row) => row.id === member.threadId);
          const sessions = new Set(
            state.session?.filter((row) => row.threadId === member.threadId).map((row) => row.id),
          );
          return {
            ...member,
            thread,
            usage: (state.usage ?? []).filter((row) => sessions.has(row.sessionId)),
          };
        }),
      };
    }
    if (!commandId) throw Error("command_id_required");
    const request = { method, params };
    const replay = host.store.receipt<{ request: unknown; value: unknown }>(commandId);
    if (replay) {
      if (!isDeepStrictEqual(replay.result.request, request))
        throw Error("command_receipt_conflict");
      return replay.result.value;
    }
    const definitions = ["compare.create", "compare.differences"].includes(method)
      ? (await host.definitions?.())?.definitions
      : undefined;
    const summaryPrompt =
      method === "compare.differences"
        ? compareSummaryPrompt(host.store.snapshot(), String(params.id))
        : undefined;
    if (
      summaryPrompt !== undefined &&
      params.expectedPrompt !== undefined &&
      params.expectedPrompt !== summaryPrompt
    )
      throw Error("compare_answers_changed");
    const check = await host.privacy.prepareData(
      summaryPrompt === undefined ? params : { params, prompt: summaryPrompt },
    );
    const before = host.store.lastSeq();
    let produced = false;
    const receipt = host.store.dispatch(commandId, (state) => {
      produced = true;
      check(state);
      const context = {
        commandId,
        at: new Date().toISOString(),
        actor: { kind: "human" as const, id: "local-owner" },
      };
      const id = String(params.id),
        threadId = String(params.threadId);
      const outcome =
        method === "compare.create"
          ? createCompare(
              capabilityState(state, definitions),
              params as unknown as Parameters<typeof createCompare>[1],
              context,
            )
          : method === "compare.send"
            ? sendCompare(
                state,
                id,
                params.input as UserInput,
                params.outputMode as OutputMode | undefined,
                context,
              )
            : method === "compare.resolve"
              ? resolveCompare(
                  state,
                  id,
                  params.action as "continue" | "close",
                  params.threadId as string | undefined,
                  context,
                )
              : method === "compare.differences"
                ? createCompareDifferences(
                    capabilityState(state, definitions),
                    id,
                    String(params.profileId),
                    randomUUID(),
                    summaryPrompt ?? "",
                    context,
                  )
                : method === "compare.vote"
                  ? voteCompare(state, id, threadId, params.vote as "better" | null, context)
                  : widenCompare(state, id, threadId, params.confirmed === true, context);
      return { events: outcome.events, result: { request, value: outcome.result } };
    });
    if (!isDeepStrictEqual(receipt.result.request, request))
      throw Error("command_receipt_conflict");
    if (produced) {
      host.publish(host.store.eventsSince(before));
      const groupId =
        method === "compare.create"
          ? String((params.value as { id: string }).id)
          : String(params.id);
      if (
        method === "compare.differences" &&
        (receipt.result.value as { created?: boolean }).created === true
      )
        void host
          .wake(String((receipt.result.value as { summaryThreadId: string }).summaryThreadId))
          .catch(() => {});
      if (method === "compare.create" || method === "compare.send")
        for (const member of compareMembers(host.store.snapshot(["compareMember"]), groupId))
          void host.wake(member.threadId).catch(() => {});
    }
    return receipt.result.value;
  };
}

function capabilityState(
  state: import("@zoltbot/core").DomainState,
  definitions: import("@zoltbot/protocol").AgentDefinition[] | undefined,
) {
  if (!definitions) return state;
  return {
    ...state,
    agentDefinition:
      state.agentDefinition?.map((row) => {
        const current = definitions.find(
          (def) => def.id === row.id && def.adapter === row.adapter && def.flavor === row.flavor,
        );
        return current
          ? {
              ...row,
              staticCapabilities: {
                ...(row.staticCapabilities as object),
                readOnly: current.staticCapabilities.readOnly === true,
              },
            }
          : row;
      }) ?? [],
  };
}
