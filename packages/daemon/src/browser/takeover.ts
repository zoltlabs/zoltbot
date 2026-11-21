// B3: the owner takes over the agent's browser. A gate card keeps the agent waiting (I5) until
// the owner hands it back from the panel or answers the card.
import { randomUUID } from "node:crypto";
import { type CommandContext, type DomainState, handle, requestInteraction } from "@zoltbot/core";
import type { DomainEvent } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import type { BrowserHost } from "./host.js";
import { HELP_MARK, type HelpRequest, parseInput } from "./takeover-files.js";

export const TAKEOVER_PREFIX = "browser-takeover:";
const HAND_BACK = "hand-back";
const TAKE_OVER = "take-over";
const HELP_TITLES: Record<HelpRequest["reason"], (name: string, site: string) => string> = {
  sign_in: (name, site) => `${name} needs you to sign in to ${site}`,
  verification: (name, site) => `${name} needs you to finish a check on ${site}`,
  payment: (name, site) => `${name} needs you to confirm a payment on ${site}`,
  other: (name, site) => `${name} needs your help on ${site}`,
};

export function takeoverApi(options: {
  store: Store;
  host: () => BrowserHost | undefined;
  /** Calls back once the daemon's browser host exists, so `need-human` works before any RPC. */
  ready?: (setup: (host: BrowserHost) => void) => void;
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
  const closeCard = (interactionId: string, action: "accept" | "cancel", option = HAND_BACK) =>
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
              ...(action === "accept" ? { answers: { choice: { options: [option] } } } : {}),
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

  const nameOf = (threadId: string) => {
    const state = store.snapshot(["thread", "agent"]);
    const thread = state.thread?.find((t) => t.id === threadId);
    if (!thread) throw Error("thread_not_found");
    const agent = state.agent?.find((a) => a.id === thread.agentId);
    // The chat's title is the name the owner knows this agent by in the sidebar.
    return { agentId: thread.agentId, name: String(thread.title || agent?.name || "The agent") };
  };

  const raise = (
    threadId: string,
    id: string,
    card: { title: string; prompt: string; option: { id: string; label: string } },
  ) => {
    const { agentId } = nameOf(threadId);
    write(id, (s, context) => [
      requestInteraction(
        s,
        {
          id,
          agentId,
          threadId,
          type: "gate",
          title: card.title.slice(0, 200),
          chain: [{ kind: "system", id: "browser-takeover" }],
          urgency: "blocking",
          items: [{ id: "choice", prompt: card.prompt.slice(0, 2000), options: [card.option] }],
        },
        `${id}:item`,
        context,
      ).events,
    ]);
  };

  /** The takeover card; the control file stays (or starts) so the agent keeps waiting. */
  const takeCard = (host: BrowserHost, threadId: string) => {
    const id = `${TAKEOVER_PREFIX}${threadId}:${randomUUID()}`;
    raise(threadId, id, {
      title: "You’re in control of the browser",
      prompt: `${nameOf(threadId).name} waits until you hand it back.`,
      option: { id: HAND_BACK, label: "Hand back" },
    });
    return host.control(threadId, id);
  };

  /** B4: the agent's `need-human` request becomes a card; its browser commands wait. */
  const ask = (host: BrowserHost, threadId: string, request: HelpRequest, url: string) => {
    let site = "a site";
    try {
      site = new URL(url).host || site;
    } catch {}
    const { name } = nameOf(threadId);
    const id = `${TAKEOVER_PREFIX}${threadId}:${HELP_MARK}${randomUUID()}`;
    raise(threadId, id, {
      title: HELP_TITLES[request.reason](name, site),
      prompt: request.note
        ? `${name} says: “${request.note}”`
        : "Take over to finish, then hand it back.",
      option: { id: TAKE_OVER, label: "Take over" },
    });
    host.control(threadId, id);
  };

  const wired = new WeakSet<BrowserHost>();
  const wire = (host: BrowserHost) => {
    if (wired.has(host)) return host;
    wired.add(host);
    host.onControlLost = (interactionId) => closeCard(interactionId, "cancel");
    host.onHelp = (threadId, request, url) => ask(host, threadId, request, url);
    return host;
  };
  const bind = () => {
    const host = options.host();
    return host && wire(host);
  };
  options.ready?.((host) => wire(host));

  return {
    /** Gives the owner the browser. The agent's next browser command waits. */
    take(threadId: string) {
      const host = bind();
      if (!host?.forThread(threadId)) throw Error("browser_not_running");
      const current = host.controller(threadId);
      // Taking over from the panel answers an open request for help.
      if (current?.includes(`:${HELP_MARK}`)) {
        closeCard(current, "accept", TAKE_OVER);
        return { control: true, url: takeCard(host, threadId) || null };
      }
      if (current) return { control: true, url: host.forThread(threadId)?.page?.url() ?? null };
      return { control: true, url: takeCard(host, threadId) || null };
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
        if (host.controller(threadId) !== event.aggregateId) continue;
        if (!event.aggregateId.includes(`:${HELP_MARK}`)) {
          host.control(threadId, undefined);
          continue;
        }
        const answer = (
          event.payload as {
            resolution?: { action?: string; answers?: Record<string, { options?: string[] }> };
          }
        ).resolution;
        if (answer?.action === "accept" && answer.answers?.choice?.options?.includes(TAKE_OVER))
          // Not inside the store's own notification.
          queueMicrotask(() => {
            if (host.controller(threadId) === event.aggregateId) takeCard(host, threadId);
          });
        else
          host.control(
            threadId,
            undefined,
            "The owner didn’t take over the browser. Carry on without that step, or ask again later.",
          );
      }
    },
  };
}
