import { randomUUID } from "node:crypto";
import { applyEvents, handle, requestInteraction } from "@zoltbot/core";
import type { ToolActor, ToolInvocation } from "@zoltbot/hostmcp";
import {
  applyWriteDecision,
  defaultWriteCaps,
  type KnowledgeWriteInput,
  knowledgeFingerprint,
  userScope,
} from "@zoltbot/knowledge";
import { HOST_WORKSPACE_REF } from "@zoltbot/protocol";
import type { RuntimeContext } from "../api.js";
import { type ChiefChatStatus, chiefChats } from "./digest.js";
import {
  chiefKeys,
  chiefName,
  chiefNotes,
  isChief,
  settingCommand,
  startedByUser,
} from "./identity.js";
import { chiefInbox } from "./inbox.js";
import { notifyTools } from "./notify.js";
import {
  type ChiefRank,
  type ChiefRecommendation,
  chiefKind,
  chiefQueue,
  chiefRanks,
  queueCandidates,
} from "./queue.js";
import { timerTools } from "./timers.js";
import {
  bounded,
  type ChiefAction,
  type ChiefRelayedAnswer,
  describe,
  hash,
  liveThread,
  refusal,
  relayedAnswer,
  text,
  titleOf,
  verbs,
} from "./tools-model.js";

export { respondChiefApproval, respondChiefIdea } from "./tools-actions.js";
export { chiefToolDefinitions, chiefToolNames } from "./tools-definitions.js";
export { type ChiefAction, type ChiefRelayedAnswer, relayedAnswer } from "./tools-model.js";

export function chiefTools(context: RuntimeContext) {
  const snapshot = () => context.store.snapshot();
  async function propose(call: ToolInvocation, action: ChiefAction, idKey: unknown) {
    const base = hash([call.actor.threadId, action.tool, idKey]);
    const interactionId = `chief-approval-${base.slice(0, 32)}`;
    const commandId = `chief:${base}`;
    const check = await context.privacy.prepareData(action);
    const before = context.store.lastSeq();
    let produced = false;
    const receipt = context.store.dispatch<Record<string, unknown>>(commandId, (state) => {
      check(state);
      produced = true;
      const markdown = describe(state, action);
      const requested = requestInteraction(
        state,
        {
          id: interactionId,
          agentId: call.actor.agentId,
          threadId: call.actor.threadId,
          type: "approval",
          title: `${chiefName(state)}: ${verbs[action.tool]}`,
          context: { toolName: action.tool, markdown, toolInput: { chiefAction: action } },
          items: [
            {
              id: "action",
              header: "Action",
              prompt: markdown.length > 2000 ? `${markdown.slice(0, 1990)}…` : markdown,
              choices: [{ id: "allow_once" }, { id: "reject_once" }],
            },
          ],
          chain: [{ kind: "agent", id: call.actor.agentId }],
          urgency: "background",
          nativeRef: HOST_WORKSPACE_REF,
        },
        `${interactionId}:item`,
        {
          commandId,
          at: new Date().toISOString(),
          actor: { kind: "agent", id: call.actor.agentId },
        },
      );
      return { events: requested.events, result: { status: "pending", interactionId } };
    });
    if (receipt.result.interactionId !== interactionId) throw new Error("command_receipt_conflict");
    if (produced) context.publish(context.store.eventsSince(before));
    return {
      status: "pending",
      interactionId,
      note: "The user must approve this. The outcome arrives as a later message.",
    };
  }

  const tools = new Map<string, (call: ToolInvocation) => Promise<unknown>>([
    [
      "chief_overview",
      async (call) => {
        const args = call.arguments as {
          workspaceId?: string;
          status?: ChiefChatStatus;
          query?: string;
        };
        const state = snapshot();
        const words = (args.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
        const inside = (chat: { projectId?: string; id: string }) => {
          if (!args.workspaceId) return true;
          if (chat.projectId === args.workspaceId) return true;
          const node = liveThread(state, chat.id)?.node as
            | { type?: string; id?: string }
            | undefined;
          return node?.type === "subproject" && node.id === args.workspaceId;
        };
        const chats = chiefChats(state)
          .filter((chat) => inside(chat))
          .filter((chat) => !args.status || chat.status === args.status)
          .filter((chat) => words.every((word) => chat.title.toLowerCase().includes(word)))
          .map(({ projectId: _projectId, ...chat }) => chat);
        const workspaces = (state.project ?? [])
          .filter((row) => !row.archived)
          .map((row) => ({
            id: text(row.id),
            name: text(row.name),
            teams: (state.subproject ?? [])
              .filter((team) => team.projectId === row.id && !team.archived)
              .map((team) => ({ id: text(team.id), name: text(team.name) })),
          }));
        return bounded(
          { workspaces: args.workspaceId ? [] : workspaces, chats, total: chats.length },
          "chats",
        );
      },
    ],
    [
      "chief_read_chat",
      async (call) => {
        const id = String((call.arguments as { chatId: string }).chatId);
        const state = snapshot();
        const chat = chiefChats(state).find((row) => row.id === id);
        if (!chat) return refusal("chat_not_found");
        const output = (state.item ?? [])
          .filter((row) => row.threadId === id && row.kind === "message")
          .sort((a, b) => Number(a.seq) - Number(b.seq))
          .map((row) => text((row.body as { text?: unknown }).text))
          .join("\n")
          .slice(-2400);
        const result = { ...chat, recentOutput: output };
        while (JSON.stringify(result).length > 3800)
          result.recentOutput = result.recentOutput.slice(
            Math.floor(result.recentOutput.length / 2),
          );
        return result;
      },
    ],
    [
      "chief_note",
      async (call) => {
        const args = call.arguments as { chatId?: string; text: string };
        const note = args.text.trim().replace(/\s+/g, " ").slice(0, 280);
        if (args.chatId && !liveThread(snapshot(), args.chatId)) return refusal("chat_not_found");
        const check = await context.privacy.prepareData(note);
        const commandId = `chief-note:${randomUUID()}`,
          before = context.store.lastSeq();
        context.store.dispatch(commandId, (state) => {
          check(state);
          const at = new Date().toISOString();
          const notes = chiefNotes(state);
          const chats = { ...notes.chats };
          let summary = notes.summary;
          if (args.chatId) {
            if (note) chats[args.chatId] = { text: note, at };
            else delete chats[args.chatId];
          } else summary = note ? { text: note, at } : undefined;
          // Notes on chats that are gone would only grow the setting.
          for (const id of Object.keys(chats)) if (!liveThread(state, id)) delete chats[id];
          const value = { ...(summary ? { summary } : {}), chats };
          return handle(
            state,
            state.settings?.some((row) => row.key === chiefKeys.notes)
              ? { type: "update", kind: "settings", id: chiefKeys.notes, changes: { value } }
              : { type: "create", kind: "settings", value: { key: chiefKeys.notes, value } },
            { commandId, at, actor: { kind: "agent", id: call.actor.agentId } },
          );
        });
        context.publish(context.store.eventsSince(before));
        return { ok: true };
      },
    ],
    [
      "chief_start_chat",
      async (call) => {
        const args = call.arguments as {
          key: string;
          workspaceId: string;
          title: string;
          brief: string;
          profileId?: string;
        };
        const state = snapshot();
        const team = state.subproject?.find((row) => row.id === args.workspaceId && !row.archived);
        const project = state.project?.find(
          (row) => row.id === (team ? team.projectId : args.workspaceId) && !row.archived,
        );
        if (!project) return refusal("workspace_not_found");
        const profileId = args.profileId ?? (text(project.defaultAgentId) || call.actor.agentId);
        if (!state.agent?.some((row) => row.id === profileId && !row.archived))
          return refusal("profile_not_found");
        const chat = `chief-chat-${hash([call.actor.threadId, args.key]).slice(0, 24)}`;
        return propose(
          call,
          {
            tool: "chief_start_chat",
            chatId: chat,
            projectId: text(project.id),
            node: team
              ? { type: "subproject", id: text(team.id) }
              : { type: "project", id: text(project.id) },
            title: args.title,
            brief: args.brief,
            profileId,
          },
          args.key,
        );
      },
    ],
    [
      "chief_message_chat",
      async (call) => {
        const args = call.arguments as { key: string; chatId: string; text: string };
        if (!liveThread(snapshot(), args.chatId)) return refusal("chat_not_found");
        const messageId = `chief-msg-${hash([call.actor.threadId, args.key]).slice(0, 24)}`;
        return propose(
          call,
          { tool: "chief_message_chat", chatId: args.chatId, text: args.text, messageId },
          args.key,
        );
      },
    ],
    [
      "chief_stop_chat",
      async (call) => {
        const id = String((call.arguments as { chatId: string }).chatId);
        const state = snapshot();
        if (!liveThread(state, id)) return refusal("chat_not_found");
        const turn = state.turn?.find((row) => row.threadId === id && row.status === "running");
        if (!turn) return refusal("not_running");
        return propose(
          call,
          { tool: "chief_stop_chat", chatId: id, turnId: text(turn.id) },
          turn.id,
        );
      },
    ],
    [
      "chief_triage",
      async (call) => {
        const args = call.arguments as {
          items: {
            interactionId: string;
            rank: ChiefRank;
            why: string;
            recommend?: ChiefRecommendation["decision"];
            choice?: string;
            draft?: string;
          }[];
        };
        const refused: { interactionId: string; error: string }[] = [];
        const check = await context.privacy.prepareData(args.items);
        const commandId = `chief-triage:${randomUUID()}`,
          before = context.store.lastSeq();
        const receipt = context.store.dispatch<Record<string, unknown>>(commandId, (state) => {
          check(state);
          const at = new Date().toISOString();
          const queue = chiefQueue(state);
          const pending = new Map(queueCandidates(state).map((row) => [text(row.id), row]));
          let saved = 0;
          for (const item of args.items) {
            const row = pending.get(item.interactionId);
            if (!row) {
              refused.push({ interactionId: item.interactionId, error: "not_pending" });
              continue;
            }
            const options = (
              (row.items as { options?: { id: string }[] }[])?.[0]?.options ?? []
            ).map((option) => option.id);
            if (item.choice && !options.includes(item.choice)) {
              refused.push({ interactionId: item.interactionId, error: "unknown_option" });
              continue;
            }
            const recommend: ChiefRecommendation | undefined = item.recommend
              ? {
                  decision: item.recommend,
                  ...(item.choice ? { choice: item.choice } : {}),
                  ...(item.draft?.trim() ? { text: item.draft.trim() } : {}),
                }
              : undefined;
            queue.items[item.interactionId] = {
              rank: chiefRanks.includes(item.rank) ? item.rank : "today",
              why: item.why.replace(/\s+/g, " ").trim().slice(0, 200),
              ...(recommend ? { recommend } : {}),
              at,
              threadId: text(row.threadId),
              kind: chiefKind(state, row),
              title: titleOf(row),
            };
            saved += 1;
          }
          if (!saved) return { events: [], result: { saved } };
          const out = handle(state, settingCommand(state, chiefKeys.queue, queue), {
            commandId,
            at,
            actor: { kind: "agent", id: call.actor.agentId },
          });
          return { events: out.events, result: { saved } };
        });
        context.publish(context.store.eventsSince(before));
        return { saved: receipt.result.saved, ...(refused.length ? { refused } : {}) };
      },
    ],
    [
      "chief_answer",
      async (call) => {
        const args = call.arguments as {
          key: string;
          items: {
            interactionId: string;
            decision: "approve" | "decline" | "answer";
            choice?: string;
            text?: string;
          }[];
        };
        // Answers come from the person's own words, never from a wake-up or a notice.
        if (!startedByUser(context.store, call.actor.threadId))
          return refusal("user_message_required", {
            why: "Only answer when the user just told you their decisions in this turn.",
          });
        const state = snapshot();
        const pending = new Map(queueCandidates(state).map((row) => [text(row.id), row]));
        const items: ChiefRelayedAnswer[] = [];
        const refused: Record<string, unknown>[] = [];
        const seen = new Set<string>();
        for (const item of args.items) {
          const row = pending.get(item.interactionId);
          const built = seen.has(item.interactionId)
            ? { error: "duplicate" }
            : row
              ? relayedAnswer(row, item)
              : { error: "not_pending" };
          seen.add(item.interactionId);
          if ("error" in built) refused.push({ interactionId: item.interactionId, ...built });
          else items.push(built);
        }
        if (!items.length) return refusal("nothing_to_send", { refused });
        const proposed = await propose(call, { tool: "chief_answer", items }, args.key);
        return refused.length ? { ...proposed, refused } : proposed;
      },
    ],
    [
      "chief_idea",
      async (call) => {
        const args = call.arguments as {
          op: "promote" | "drop";
          ids?: string[];
          key?: string;
          title?: string;
          why?: string;
        };
        const ids = [...new Set(args.ids ?? [])];
        if (args.op === "drop") {
          if (!ids.length) return refusal("ids_required");
          const commandId = `chief-idea-drop:${randomUUID()}`,
            before = context.store.lastSeq();
          const receipt = context.store.dispatch<Record<string, unknown>>(commandId, (state) => {
            const entries = chiefInbox(state);
            let dropped = 0;
            const next = entries.map((entry) => {
              if (!ids.includes(entry.id) || entry.status !== "new") return entry;
              dropped += 1;
              return { ...entry, status: entry.kind === "idea" ? "dropped" : "done" } as const;
            });
            if (!dropped) return { events: [], result: { dropped } };
            const out = handle(state, settingCommand(state, chiefKeys.inbox, { entries: next }), {
              commandId,
              at: new Date().toISOString(),
              actor: { kind: "agent", id: call.actor.agentId },
            });
            return { events: out.events, result: { dropped } };
          });
          context.publish(context.store.eventsSince(before));
          return { dropped: receipt.result.dropped };
        }
        if (!args.key || !args.title?.trim() || !args.why?.trim())
          return refusal("key_title_and_why_required");
        const sources = chiefInbox(snapshot()).filter((entry) => ids.includes(entry.id));
        if (sources.length !== ids.length || sources.some((entry) => entry.kind !== "idea"))
          return refusal("unknown_idea", { ids });
        if (sources.some((entry) => entry.status !== "new")) return refusal("already_handled");
        const interactionId = `chief-idea-${hash([call.actor.threadId, args.key]).slice(0, 24)}`;
        const commandId = `chief:${interactionId}`;
        const title = args.title.trim(),
          why = args.why.trim();
        const check = await context.privacy.prepareData([title, why]);
        const before = context.store.lastSeq();
        context.store.dispatch(commandId, (state) => {
          check(state);
          const at = new Date().toISOString();
          const actor = { kind: "agent" as const, id: call.actor.agentId };
          const from = [
            ...new Set(
              sources.map((entry) => `${entry.fromTitle}${entry.place ? ` (${entry.place})` : ""}`),
            ),
          ];
          const caution = sources.some((entry) => entry.untrusted)
            ? " One source had read content Zoltbot cannot vouch for."
            : "";
          const prompt = `${from.length ? `Idea from ${from.join(" and ")}` : `Idea from ${chiefName(state)}`}: ${title}\nWhy: ${why}${caution}`;
          const requested = requestInteraction(
            state,
            {
              id: interactionId,
              agentId: call.actor.agentId,
              threadId: call.actor.threadId,
              type: "question",
              title: `Idea: ${title}`.slice(0, 200),
              context: {
                toolName: "chief_idea",
                markdown: prompt,
                toolInput: { chiefIdea: { ids, title, why } },
              },
              items: [
                {
                  id: "idea",
                  header: "Idea",
                  prompt: prompt.slice(0, 2000),
                  options: [
                    {
                      id: "start",
                      label: "Start it",
                      description: `${chiefName(state)} drafts a brief for a new chat, which you approve`,
                      recommended: true,
                    },
                    { id: "later", label: "Not now" },
                    { id: "never", label: "Never like this" },
                  ],
                },
              ],
              chain: [{ kind: "agent", id: call.actor.agentId }],
              urgency: "background",
              nativeRef: HOST_WORKSPACE_REF,
            },
            `${interactionId}:item`,
            { commandId, at, actor },
          );
          let next = applyEvents(state, requested.events);
          const created = next.interaction?.find((row) => row.id === interactionId) ?? {};
          // Ideas wait in the queue: ranked later, they never notify.
          const queue = chiefQueue(next);
          queue.items[interactionId] = {
            rank: "later",
            why: why.slice(0, 200),
            recommend: { decision: "answer", choice: "start" },
            at,
            threadId: call.actor.threadId,
            kind: chiefKind(next, created),
            title: `Idea: ${title}`.slice(0, 100),
          };
          const ranked = handle(next, settingCommand(next, chiefKeys.queue, queue), {
            commandId: `${commandId}:queue`,
            at,
            actor,
          });
          next = applyEvents(next, ranked.events);
          const entries = chiefInbox(next).map((entry) =>
            ids.includes(entry.id)
              ? { ...entry, status: "promoted" as const, interactionId }
              : entry,
          );
          const marked = ids.length
            ? handle(next, settingCommand(next, chiefKeys.inbox, { entries }), {
                commandId: `${commandId}:inbox`,
                at,
                actor,
              }).events
            : [];
          return {
            events: [...requested.events, ...ranked.events, ...marked].map((event, index) => ({
              ...event,
              eventId: `${commandId}:${index}`,
            })),
            result: { interactionId },
          };
        });
        context.publish(context.store.eventsSince(before));
        return {
          status: "queued",
          interactionId,
          note: "It waits in the user's queue as an idea.",
        };
      },
    ],
    [
      "chief_learn",
      async (call) => {
        const args = call.arguments as { title: string; body: string; evidence: string[] };
        const state = snapshot();
        const queue = chiefQueue(state);
        const ids = [...new Set(args.evidence)];
        const cited = ids.map((id) => [id, queue.items[id]] as const);
        if (
          cited.some(
            ([, triage]) =>
              !triage?.outcome ||
              triage.outcome.learned ||
              !["overruled", "edited"].includes(triage.outcome.result),
          )
        )
          return refusal("evidence_must_be_unlearned_overrules");
        if (
          (state.knowledgeProposal ?? []).some(
            (row) => row.threadId === call.actor.threadId && row.state === "pending",
          )
        )
          return refusal("proposal_pending", { why: "Wait for the user to review the last one." });
        const title = args.title.trim(),
          body = args.body.trim();
        if (await context.privacy.containsSecret([title, body])) return refusal("secret_detected");
        const input: KnowledgeWriteInput = {
          op: "create",
          scope: "user",
          kind: "preference",
          title,
          body,
          tags: ["main-agent"],
          // One source per chat, labelled by the first decision cited from it.
          evidence: cited
            .filter(
              ([, triage], index) =>
                cited.findIndex(([, other]) => other?.threadId === triage?.threadId) === index,
            )
            .map(([, triage]) => ({
              kind: "thread" as const,
              ref: String(triage?.threadId),
              label: String(triage?.title).slice(0, 200),
            })),
          reason: `From ${ids.length} decisions where the user overruled ${chiefName(state)}.`,
        };
        const fingerprint = knowledgeFingerprint(userScope, input);
        if (
          (state.knowledgeProposal ?? []).some(
            (row) => row.fingerprint === fingerprint && row.state === "rejected",
          )
        )
          return refusal("previously_rejected");
        const commandId = `chief-learn:${randomUUID()}`,
          before = context.store.lastSeq();
        const receipt = context.store.dispatch<Record<string, unknown>>(commandId, (current) => {
          const at = new Date().toISOString();
          const actor = { kind: "agent" as const, id: call.actor.agentId };
          const proposed = applyWriteDecision(
            {
              sessionId: call.actor.sessionId,
              agentId: call.actor.agentId,
              threadId: call.actor.threadId,
              node: userScope,
              tainted: false,
              grants: [],
              written: { applied: 0, proposed: 0 },
              caps: defaultWriteCaps,
              secretDetected: false,
            },
            input,
            {
              outcome: "proposed",
              reason: "user_scope",
              target: userScope,
              fingerprint,
              conflicts: [],
            },
            { commandId, at, actor },
          );
          const learned = chiefQueue(current);
          for (const id of ids) {
            const triage = learned.items[id];
            if (triage?.outcome)
              learned.items[id] = { ...triage, outcome: { ...triage.outcome, learned: true } };
          }
          const marked = handle(
            applyEvents(current, proposed.events),
            settingCommand(current, chiefKeys.queue, learned),
            { commandId: `${commandId}:queue`, at, actor },
          );
          return {
            events: [...proposed.events, ...marked.events].map((event, index) => ({
              ...event,
              eventId: `${commandId}:${index}`,
            })),
            result: { proposalId: proposed.result.proposalId },
          };
        });
        context.publish(context.store.eventsSince(before));
        return {
          status: "proposed",
          proposalId: receipt.result.proposalId,
          note: "The user reviews it in Knowledge review; nothing changes until they approve.",
        };
      },
    ],
    ...timerTools(context),
    ...notifyTools(context),
  ]);
  return {
    tools,
    authorize: (actor: ToolActor) => isChief(context.store, actor.threadId),
  };
}
