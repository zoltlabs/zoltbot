import { createHash } from "node:crypto";
import type { DomainState } from "@zoltbot/core";
import type { InteractionAnswer } from "@zoltbot/protocol";
import type { InteractionEngine } from "./interaction-engine.js";

export function interactionApi(host: {
  engine?: InteractionEngine;
  load?: () => Promise<InteractionEngine>;
  snapshot(): DomainState;
  seq(): number;
}) {
  return async (
    method: string,
    params: Record<string, unknown>,
    commandId?: string,
  ): Promise<unknown> => {
    if (
      ![
        "interaction.list",
        "interaction.answer",
        "interaction.batchAnswer",
        "interaction.defer",
        "interaction.forwardLate",
      ].includes(method)
    )
      return undefined;
    const actor = { kind: "human" as const, id: "local-owner" };
    if (method !== "interaction.list") {
      if (!commandId) throw new Error("command_id_required");
      const engine = host.engine ?? (await host.load?.());
      if (!engine) throw new Error("interaction_runtime_unavailable");
      if (method === "interaction.forwardLate")
        return engine.forwardLate(
          {
            id: String(params.id),
            version: Number(params.version),
            text: params.text as string,
            confirmed: params.confirmed === true,
          },
          commandId,
          actor,
        );
      if (method === "interaction.defer") return engine.defer(String(params.id), commandId, actor);
      if (method === "interaction.answer")
        return engine.answer(
          String(params.id),
          Number(params.version),
          params.answer as InteractionAnswer,
          commandId,
          actor,
        );
      return {
        results: await engine.batch(
          params.items as { id: string; version: number; answer: InteractionAnswer }[],
          commandId,
          actor,
        ),
      };
    }
    const state = host.snapshot(),
      seq = host.seq();
    const limit = params.limit ?? 50;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 200)
      throw new Error("invalid_interaction_page_size");
    const filter = createHash("sha256")
      .update(JSON.stringify([params.agentId ?? null, params.projectId ?? null]))
      .digest("hex")
      .slice(0, 16);
    let offset = 0;
    if (params.cursor !== undefined) {
      const match = /^i1:(\d{1,16}):(\d{1,9}):([a-f0-9]{16})$/.exec(String(params.cursor));
      if (!match || Number(match[1]) !== seq || match[3] !== filter)
        throw new Error("interaction_cursor_stale");
      offset = Number(match[2]);
    }
    const setting = state.settings?.find((row) => row.key === "interaction.deferred")?.value;
    const deferred = new Map(
      (Array.isArray(setting) ? setting : []).map((id, index) => [id, index]),
    );
    const rows = (state.interaction ?? [])
      .filter((row) => {
        if (params.agentId && row.agentId !== params.agentId) return false;
        return (
          !params.projectId ||
          state.thread?.some(
            (thread) => thread.id === row.threadId && thread.projectId === params.projectId,
          )
        );
      })
      .sort((a, b) => {
        const pending = Number(b.state === "pending") - Number(a.state === "pending");
        if (pending) return pending;
        const ad = deferred.get(a.id),
          bd = deferred.get(b.id);
        if ((ad === undefined) !== (bd === undefined)) return ad === undefined ? -1 : 1;
        if (ad !== undefined && bd !== undefined && ad !== bd) return ad - bd;
        return (
          Number(b.urgency === "blocking") - Number(a.urgency === "blocking") ||
          String(a.createdAt).localeCompare(String(b.createdAt)) ||
          String(a.id).localeCompare(String(b.id))
        );
      });
    return {
      items: structuredClone(rows.slice(offset, offset + limit)),
      ...(offset + limit < rows.length ? { cursor: `i1:${seq}:${offset + limit}:${filter}` } : {}),
    };
  };
}
