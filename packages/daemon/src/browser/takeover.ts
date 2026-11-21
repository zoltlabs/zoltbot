// B3: the owner takes over the agent's browser. A gate card keeps the agent waiting (I5) until
// the owner hands it back from the panel or answers the card.
import { randomUUID } from "node:crypto";
import { type CommandContext, type DomainState, handle, requestInteraction } from "@zoltbot/core";
import type { DomainEvent } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import type { BrowserHost } from "./host.js";
import { parseInput } from "./takeover-files.js";

export const TAKEOVER_PREFIX = "browser-takeover:";
const HAND_BACK = "hand-back";

export function takeoverApi(options: {
  store: Store;
  host: () => BrowserHost | undefined;
  publish?: (events: DomainEvent[]) => void;
}) {
  const { store } = options;
  const write = (
    commandId: string,
    build: (state: DomainState, context: CommandContext) => DomainEvent[][],
  ) => {
    const before = store.lastSeq();
    store.dispatch(commandId, (state) => {
      const at = new Date().toISOString();
      const context: CommandContext = {
        commandId,
        at,
        actor: { kind: "human", id: "local-owner" },
      };
      return {
        events: build(state, context)
          .flat()
          .map((event, index) => ({ ...event, eventId: `${commandId}:${index}` })),
        result: {},
      };
    });
    options.publish?.(store.eventsSince(before));
  };

  /** Closes the card if it's still open; `cancel` when the browser went away. */
  const closeCard = (interactionId: string, action: "accept" | "cancel") =>
    write(`${interactionId}:${action}`, (state, context) => {
      const card = state.interaction?.find((row) => row.id === interactionId);
      if (card?.state !== "pending") return [];
      return [
        handle(
          state,
          {
            type: "answer",
            id: interactionId,
            version: Number(card.version),
            answer: {
              action,
              ...(action === "accept" ? { answers: { choice: { options: [HAND_BACK] } } } : {}),
              by: context.actor,
              at: context.at,
            },
          },
          context,
        ).events,
      ];
    });

  // A daemon that stopped while the owner had control left its card open; no browser waits now.
  for (const card of store.snapshot(["interaction"]).interaction ?? [])
    if (card.state === "pending" && String(card.id).startsWith(TAKEOVER_PREFIX))
      closeCard(String(card.id), "cancel");

  const bind = () => {
    const host = options.host();
    if (host && !host.onControlLost)
      host.onControlLost = (interactionId) => closeCard(interactionId, "cancel");
    return host;
  };

  return {
    /** Gives the owner the browser. The agent's next browser command waits. */
    take(threadId: string) {
      const host = bind();
      if (!host?.forThread(threadId)) throw Error("browser_not_running");
      const current = host.controller(threadId);
      if (current) return { control: true, url: host.forThread(threadId)?.page?.url() ?? null };
      const state = store.snapshot(["thread", "agent"]);
      const thread = state.thread?.find((t) => t.id === threadId);
      if (!thread) throw Error("thread_not_found");
      const agent = state.agent?.find((a) => a.id === thread.agentId);
      // The chat's title is the name the owner knows this agent by in the sidebar.
      const name = String(thread.title || agent?.name || "The agent");
      const interactionId = `${TAKEOVER_PREFIX}${threadId}:${randomUUID()}`;
      write(interactionId, (s, context) => [
        requestInteraction(
          s,
          {
            id: interactionId,
            agentId: thread.agentId,
            threadId,
            type: "gate",
            title: "You’re in control of the browser",
            chain: [{ kind: "system", id: "browser-takeover" }],
            urgency: "blocking",
            items: [
              {
                id: "choice",
                prompt: `${name} waits until you hand it back.`,
                options: [{ id: HAND_BACK, label: "Hand back" }],
              },
            ],
          },
          `${interactionId}:item`,
          context,
        ).events,
      ]);
      return { control: true, url: host.control(threadId, interactionId) || null };
    },

    /** Returns the browser to the agent and closes the card. */
    handBack(threadId: string) {
      const host = bind();
      const interactionId = host?.controller(threadId);
      if (!host || !interactionId) return { control: false };
      const url = host.control(threadId, undefined);
      closeCard(interactionId, "accept");
      return { control: false, url: url || null };
    },

    async input(threadId: string, event: unknown) {
      const host = bind();
      if (!host) throw Error("browser_not_in_control");
      await host.input(threadId, parseInput(event));
      return { ok: true };
    },

    /** A takeover card answered elsewhere (Needs you, the phone) hands the browser back too. */
    observe(events: readonly DomainEvent[]) {
      const host = options.host();
      if (!host) return;
      for (const event of events) {
        if (event.aggregateType !== "interaction") continue;
        if (!event.aggregateId.startsWith(TAKEOVER_PREFIX)) continue;
        const state = (event.payload as { state?: string }).state;
        if (state === "pending") continue;
        const threadId = event.aggregateId.slice(TAKEOVER_PREFIX.length).split(":")[0] ?? "";
        if (host.controller(threadId) === event.aggregateId) host.control(threadId, undefined);
      }
    },
  };
}
