import { createHash } from "node:crypto";
import type { DomainState } from "@zoltbot/core";
import { type Interaction, type InteractionAnswer, parse, parseEvent } from "@zoltbot/protocol";
import { callSchemas, mapRequests } from "../../../view-api/src/index.js";
import { viewGrants } from "./grants.js";
import type { ViewRegistry } from "./registry.js";

export type ViewDelegate = (
  method: string,
  params: Record<string, unknown>,
  commandId: string,
  check?: (state: DomainState) => void,
) => unknown;
export interface ViewActions {
  runtime: ViewDelegate;
  interaction: ViewDelegate;
}
export function requireViewGrant(registry: ViewRegistry, id: string, permission: string) {
  const record = registry.store.record("view", id);
  const grants = viewGrants(registry.store, id);
  if (
    !record?.enabled ||
    !record.bundleHash ||
    !(record.requested as string[]).includes(permission) ||
    !grants.includes("read") ||
    !grants.some((grant) => grant === permission)
  )
    throw Error("not_granted");
}
export async function callView(
  registry: ViewRegistry,
  actions: ViewActions,
  envelope: Record<string, unknown>,
  commandId: string,
) {
  const id = String(envelope.id),
    method = String(envelope.method);
  if (!["chats.send", "chats.interrupt", "requests.answer"].includes(method))
    throw Error("invalid");
  const check = () =>
    requireViewGrant(registry, id, method === "requests.answer" ? "approve" : "act");
  check();
  const params = parse(callSchemas[method as keyof typeof callSchemas], envelope.params) as Record<
    string,
    unknown
  >;
  if (method === "requests.answer") {
    const current = () => {
      check();
      const state = registry.store.snapshot();
      const request = state.interaction?.find((row) => row.id === params.requestId);
      if (!request) throw Error("not_found");
      if (request.version !== params.version || request.state !== "pending") throw Error("stale");
      const native = request as unknown as Interaction;
      if (native.items.some((item) => item.secret))
        throw Error("invalid: answer this request in its chat");
      const mapped = mapRequests({ entities: state }).find((row) => row.id === request.id);
      const choice = mapped?.choices.find((row) => row.id === params.choiceId);
      if (params.choiceId !== undefined && !choice) throw Error("invalid: choice was not offered");
      if (choice?.widens && envelope.confirmed !== true) throw Error("view_confirmation_required");
      return native;
    };
    const request = current();
    const choice = typeof params.choiceId === "string" ? params.choiceId : undefined;
    const answer: InteractionAnswer = {
      action:
        choice === "decline" || choice === "reject_once" || choice === "reject_rule"
          ? "decline"
          : "accept",
      by: { kind: "human", id: "local-owner" },
      at: new Date().toISOString(),
      via: { kind: "view", id },
      ...(choice && request.items.some((item) => item.choices?.some((row) => row.id === choice))
        ? { choice }
        : {}),
      ...(typeof params.feedback === "string" ? { feedback: params.feedback } : {}),
    };
    if (params.answers !== undefined) {
      answer.answers = {};
      for (const [itemId, value] of Object.entries(params.answers as Record<string, unknown>)) {
        const item = request.items.find((row) => row.id === itemId);
        if (!item) throw Error("invalid");
        answer.answers[itemId] =
          request.type === "form"
            ? (value as { value: unknown })
            : Array.isArray(value)
              ? { options: value as string[] }
              : typeof value === "string" && item.options?.some((option) => option.id === value)
                ? { options: [value] }
                : typeof value === "string"
                  ? { other: value }
                  : value && typeof value === "object" && !("value" in value)
                    ? (value as { options?: string[]; other?: string })
                    : (() => {
                        throw Error("invalid");
                      })();
      }
    }
    await actions.interaction(
      "interaction.answer",
      { id: request.id, version: params.version, answer },
      commandId,
      () => {
        current();
      },
    );
    return { ok: true };
  }
  const chatIds = params.chatIds as string[];
  const digest = createHash("sha256")
    .update(JSON.stringify([id, method, params]))
    .digest("hex");
  const previous = registry.store.receipt<{ digest: string }>(`${commandId}:audit`);
  if (previous && previous.result.digest !== digest) throw Error("command_receipt_conflict");
  const guard = await registry.checkPublic(method === "chats.send" ? params.text : { chatIds });
  check();
  const before = registry.store.lastSeq(),
    at = new Date().toISOString();
  registry.store.dispatch(`${commandId}:audit`, (state) => {
    check();
    guard(state);
    return {
      events: [
        parseEvent({
          eventId: `${commandId}:audit:0`,
          aggregateType: "audit",
          aggregateId: `audit:${commandId}`,
          type: "audit.created",
          occurredAt: at,
          payload: {
            id: `audit:${commandId}`,
            actor: { kind: "human", id: "local-owner" },
            action: method,
            target: id,
            result: "allowed",
            detail: {
              via: { kind: "view", id },
              chatIds,
              ...(method === "chats.send" ? { textLength: String(params.text).length } : {}),
            },
            at,
          },
        }),
      ],
      result: { digest },
    };
  });
  registry.publish(registry.store.eventsSince(before));
  const results = [];
  for (const [index, chatId] of chatIds.entries()) {
    check();
    const state = registry.store.snapshot();
    if (!state.thread?.some((row) => row.id === chatId && !row.archived)) {
      results.push({ chatId, result: "skipped", reason: "Chat not found." });
      continue;
    }
    const turn = state.turn?.find((row) => row.threadId === chatId && row.status === "running");
    if (method === "chats.interrupt" && !turn) {
      results.push({ chatId, result: "skipped", reason: "No running turn." });
      continue;
    }
    try {
      const result = await actions.runtime(
        method === "chats.send" ? "turn.send" : "turn.interrupt",
        {
          threadId: chatId,
          ...(method === "chats.send"
            ? { input: [{ type: "text", text: params.text }], mode: "queue" }
            : { turnId: turn?.id }),
        },
        `${commandId}:${index}`,
        check,
      );
      if (result === undefined) throw Error("Runtime unavailable.");
      results.push({ chatId, result: method === "chats.send" ? "queued" : "interrupted" });
    } catch (error) {
      if (error instanceof Error && error.message === "not_granted") throw error;
      results.push({ chatId, result: "skipped", reason: "The agent is unavailable." });
    }
  }
  return results;
}
