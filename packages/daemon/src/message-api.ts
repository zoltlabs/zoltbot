import { handle } from "@zoltbot/core/commands";
import {
  type ActorRef,
  type Delivery,
  type DomainEvent,
  type Message,
  MessageSchema,
  parse,
} from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";

type Call = (
  method: string,
  params: Record<string, unknown>,
  commandId: string,
) => Promise<unknown>;
const owner: ActorRef = { kind: "human", id: "local-owner" };
// Messages never need chat history.
const noItems = { items: { ids: [] } };

/**
 * Messages a person sends to a chat from another surface, such as forwarding from the phone. The
 * message is recorded and then delivered through `turn.send`, so it is queued, or steers a running
 * turn, exactly like typing in that chat. Agent-to-agent messages keep using `team_message`.
 */
export function messageApi(host: {
  store: Store;
  publish(events: DomainEvent[]): void;
  /** `turn.send`, through the runtime. */
  send?: Call;
}) {
  const { store } = host;
  const send = async (params: Record<string, unknown>, commandId: string) => {
    const message = parse(MessageSchema, params.message);
    if (message.origin !== "human" || message.from.kind !== "human")
      throw new Error("human_message_required");
    if (message.kind !== "message") throw new Error("invalid_message_kind");
    if (message.delivery === "interrupt") throw new Error("invalid_message_delivery");
    const text = message.body
      .map((part) => {
        if (part.type !== "text") throw new Error("text_message_required");
        return part.text;
      })
      .join("\n")
      .trim();
    if (!text) throw new Error("invalid_message");
    const before = store.lastSeq();
    const receipt = store.dispatch(
      `${commandId}:message`,
      (state) => {
        const thread = state.thread?.find((row) => row.id === message.thread && !row.archived);
        if (!thread) throw new Error("not_found: thread");
        const to = message.to[0];
        if (message.to.length !== 1 || to?.kind !== "agent" || to.id !== thread.agentId)
          throw new Error("message_target_mismatch");
        if (message.fromThread && !state.thread?.some((row) => row.id === message.fromThread))
          throw new Error("not_found: thread");
        return handle(
          state,
          {
            type: "create",
            kind: "message",
            value: { ...message, from: owner, hops: 0, root: message.id, expectsReply: false },
          },
          { commandId, at: new Date().toISOString(), actor: owner },
        );
      },
      noItems,
    );
    host.publish(store.eventsSince(before));
    const saved = parse(MessageSchema, receipt.result);
    if (saved.id !== message.id || JSON.stringify(saved.body) !== JSON.stringify(message.body))
      throw new Error("command_receipt_conflict");
    if (!host.send) throw new Error("runtime_unavailable");
    const sent = (await host.send(
      "turn.send",
      {
        threadId: String(message.thread),
        input: [{ type: "text", text }],
        mode: message.delivery === "steer" ? "steer" : "queue",
      },
      `${commandId}:send`,
    )) as { id: string; disposition: "started" | "queued" | "handled" };
    const delivery: Delivery = {
      id: sent.id,
      messageId: message.id,
      toAgentId: String(message.to[0]?.id),
      queueOrder: 0,
      state: sent.disposition === "queued" ? "queued" : "delivered",
      ...(sent.disposition === "queued" ? {} : { deliveredAt: new Date().toISOString() }),
    };
    return { messageId: message.id, deliveries: [delivery] };
  };

  return async (method: string, params: Record<string, unknown>, commandId?: string) => {
    if (method === "message.list") {
      const rows = (store.snapshot(["message"]).message ?? []) as Message[];
      const limit = typeof params.limit === "number" ? params.limit : 200;
      return {
        items: [...rows]
          .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
          .slice(0, limit),
      };
    }
    if (method !== "message.send") return undefined;
    if (!commandId) throw new Error("command_id_required");
    return send(params, commandId);
  };
}
