import {
  type Compare,
  type CompareCreate,
  CompareCreateSchema,
  CompareMemberSchema,
  CompareSchema,
  type DomainEvent,
  differencesPrompt,
  type EntityKind,
  type OutputMode,
  type Profile,
  parse,
  type UserInput,
} from "@zoltbot/protocol";
import { type CommandContext, handle, type Outcome } from "./commands.js";
import { createScopedChat } from "./hierarchy.js";
import { queueHumanInput } from "./input-queue.js";
import { applyEvents, type DomainState, entityId } from "./projectors.js";

export function comparePermission(state: DomainState, threadId: string, profile: Profile) {
  if (state.compare?.some((row) => row.summaryThreadId === threadId)) return "read_only";
  const member = state.compareMember?.find((row) => row.threadId === threadId);
  return member
    ? member.ceiling === "read_only"
      ? "read_only"
      : profile.permissionProfile
    : undefined;
}
export function compareMembers(state: DomainState, id: string) {
  return (state.compareMember ?? [])
    .filter((row) => row.compareId === id)
    .map((row) => parse(CompareMemberSchema, row))
    .sort((a, b) => a.position - b.position);
}
export function compareGroup(state: DomainState, id: string): Compare {
  const row = state.compare?.find((row) => row.id === id);
  if (!row) throw Error("compare_not_found");
  return parse(CompareSchema, row);
}
function builder(initial: DomainState, context: CommandContext) {
  if (context.actor.kind !== "human") throw Error("human_compare_required");
  let state = initial;
  const events: DomainEvent[] = [];
  const add = (outcome: Outcome) => {
    events.push(...outcome.events);
    state = applyEvents(state, outcome.events);
  };
  const write = (kind: EntityKind, value: Record<string, unknown>, verb: string) => {
    const event: DomainEvent = {
      eventId: `${context.commandId}:${events.length}`,
      commandId: context.commandId,
      aggregateType: kind,
      aggregateId: entityId(kind, value),
      type: `${kind}.${verb}`,
      occurredAt: context.at,
      payload: value,
    };
    add({ events: [event], result: value });
  };
  return {
    get state() {
      return state;
    },
    add,
    write,
    done(result: Record<string, unknown>): Outcome {
      return {
        events: events.map((event, index) => ({
          ...event,
          eventId: `${context.commandId}:${index}`,
        })),
        result,
      };
    },
  };
}
export function createCompare(
  state: DomainState,
  raw: CompareCreate,
  context: CommandContext,
): Outcome {
  const input = parse(CompareCreateSchema, raw);
  const ids = input.members.map((m) => m.profileId);
  if (
    new Set(ids).size !== ids.length ||
    new Set(input.members.map((m) => m.threadId)).size !== ids.length
  )
    throw Error("compare_distinct_members_required");
  if (input.input.some((part) => part.type === "text" && /^\s*\//.test(part.text)))
    throw Error("compare_command_not_supported");
  // Fail closed: unknown is not evidence that a native read-only ceiling is supported.
  for (const member of input.members) {
    const profile = state.agent?.find((row) => row.id === member.profileId && !row.archived);
    if (!profile) throw Error("profile_unavailable");
    const definition = state.agentDefinition?.find((row) => row.id === profile.definitionId);
    if ((definition?.staticCapabilities as Record<string, unknown> | undefined)?.readOnly !== true)
      throw Error(`compare_read_only_unavailable: ${String(profile.name)}`);
  }
  const b = builder(state, context),
    threads: Record<string, unknown>[] = [];
  const group = parse(CompareSchema, {
    ...input.value,
    title: input.value.title.slice(0, 80),
    input: input.input,
    ...(input.outputMode ? { outputMode: input.outputMode } : {}),
    state: "open",
    createdAt: context.at,
  });
  if (state.compare?.some((row) => row.id === group.id)) throw Error("compare_already_exists");
  b.write("compare", group, "created");
  for (const [position, member] of input.members.entries()) {
    const created = createScopedChat(
      b.state,
      {
        id: member.threadId,
        agentId: member.profileId,
        kind: "side",
        title: group.title,
        titleSource: "auto",
        pinned: false,
        archived: false,
        createdAt: context.at,
        lastActivityAt: context.at,
        ...(group.projectId ? { projectId: group.projectId } : {}),
        ...(group.node ? { node: group.node } : {}),
      },
      context,
    );
    b.add(created);
    threads.push(created.result);
    b.write(
      "compareMember",
      {
        threadId: member.threadId,
        compareId: group.id,
        position,
        vote: null,
        ceiling: "read_only",
      },
      "created",
    );
    b.add(
      queueHumanInput(
        b.state,
        {
          threadId: member.threadId,
          input: input.input,
          mode: "queue",
          ...(input.outputMode ? { outputMode: input.outputMode } : {}),
        },
        `${context.commandId}:input:${position}`,
        context,
      ),
    );
  }
  return b.done({ compare: group, threads });
}
export function sendCompare(
  state: DomainState,
  id: string,
  input: UserInput,
  outputMode: OutputMode | undefined,
  context: CommandContext,
): Outcome {
  if (compareGroup(state, id).state !== "open") throw Error("compare_not_open");
  if (input.some((part) => part.type === "text" && /^\s*\//.test(part.text)))
    throw Error("compare_command_not_supported");
  const b = builder(state, context);
  for (const member of compareMembers(state, id))
    b.add(
      queueHumanInput(
        b.state,
        { threadId: member.threadId, input, mode: "queue", ...(outputMode ? { outputMode } : {}) },
        `${context.commandId}:input:${member.position}`,
        context,
      ),
    );
  return b.done({ ok: true });
}
export function resolveCompare(
  state: DomainState,
  id: string,
  action: "continue" | "close",
  threadId: string | undefined,
  context: CommandContext,
): Outcome {
  const group = compareGroup(state, id),
    members = compareMembers(state, id),
    b = builder(state, context);
  if (group.state !== "open") throw Error("compare_not_open");
  if (action === "continue" && !members.some((m) => m.threadId === threadId))
    throw Error("compare_member_required");
  if (action === "close" && threadId !== undefined) throw Error("compare_close_has_no_winner");
  const next = {
    ...group,
    state: action === "continue" ? "resolved" : "closed",
    resolution: { action, ...(threadId ? { threadId } : {}), at: context.at },
    resolvedAt: context.at,
  };
  b.write("compare", next, action === "continue" ? "resolved" : "closed");
  if (action === "continue" && threadId) {
    b.add(
      handle(
        b.state,
        { type: "update", kind: "thread", id: threadId, changes: { kind: "main" } },
        context,
      ),
    );
    const seq =
      (state.item ?? [])
        .filter((row) => row.threadId === threadId)
        .reduce((n, row) => Math.max(n, Number(row.seq)), 0) + 1;
    b.add(
      handle(
        b.state,
        {
          type: "create",
          kind: "item",
          value: {
            id: `${context.commandId}:marker`,
            threadId,
            seq,
            kind: "note",
            body: {
              code: "compare",
              compareId: id,
              count: members.length,
              text: `Compared ${members.length} answers; the other answers are kept as side chats.`,
            },
            createdAt: context.at,
            updatedAt: context.at,
          },
        },
        context,
      ),
    );
  }
  return b.done({ compare: next });
}
export function voteCompare(
  state: DomainState,
  id: string,
  threadId: string,
  vote: "better" | null,
  context: CommandContext,
): Outcome {
  const group = compareGroup(state, id),
    members = compareMembers(state, id),
    b = builder(state, context);
  if (group.state !== "open") throw Error("compare_not_open");
  if (!members.some((m) => m.threadId === threadId)) throw Error("compare_member_required");
  // Clear the old vote first, preserving the SQL uniqueness constraint at every projection step.
  for (const member of [...members].sort(
    (a, b) => Number(b.vote === "better") - Number(a.vote === "better"),
  ))
    if (member.threadId === threadId || (vote === "better" && member.vote === "better"))
      b.write(
        "compareMember",
        { ...member, vote: member.threadId === threadId ? vote : null },
        "updated",
      );
  b.write("compare", group, "voted");
  return b.done({ ok: true });
}
export function widenCompare(
  state: DomainState,
  id: string,
  threadId: string,
  confirmed: boolean,
  context: CommandContext,
): Outcome {
  const group = compareGroup(state, id),
    member = compareMembers(state, id).find((m) => m.threadId === threadId);
  if (context.actor.kind !== "human" || !confirmed) throw Error("confirmation_required");
  if (group.state === "open" || !member) throw Error("compare_resolve_before_widening");
  const thread = state.thread?.find((row) => row.id === threadId);
  const profile = state.agent?.find((row) => row.id === thread?.agentId);
  if (!profile || profile.archived) throw Error("profile_unavailable");
  const b = builder(state, context);
  b.write("compareMember", { ...member, ceiling: "profile" }, "updated");
  b.add(
    handle(
      b.state,
      {
        type: "create",
        kind: "audit",
        value: {
          id: `audit:${context.commandId}`,
          actor: context.actor,
          action: "compare.widen",
          target: threadId,
          result: "allowed",
          detail: {
            confirmed: true,
            compareId: id,
            profileId: profile.id,
            permissionProfile: profile.permissionProfile,
          },
          at: context.at,
        },
      },
      context,
    ),
  );
  return b.done({ ok: true });
}

export function compareSummaryPrompt(state: DomainState, id: string) {
  compareGroup(state, id);
  return differencesPrompt(
    compareMembers(state, id).map((member) => {
      const thread = state.thread?.find((r) => r.id === member.threadId),
        profile = state.agent?.find((r) => r.id === thread?.agentId);
      const messages = (state.item ?? [])
        .filter(
          (r) =>
            r.threadId === member.threadId &&
            r.kind === "message" &&
            !(r.body as Record<string, unknown> | undefined)?.parentItemId,
        )
        .sort((a, b) => Number(a.seq) - Number(b.seq));
      const item = messages.filter((r) => r.phase === "final").at(-1) ?? messages.at(-1);
      return {
        name: String(profile?.name ?? "Profile"),
        answer: String(
          (item?.body as Record<string, unknown> | undefined)?.text ?? "(No answer available.)",
        ),
      };
    }),
  );
}
export function createCompareDifferences(
  state: DomainState,
  id: string,
  profileId: string,
  threadId: string,
  expectedPrompt: string,
  context: CommandContext,
): Outcome {
  const group = compareGroup(state, id),
    members = compareMembers(state, id),
    b = builder(state, context);
  if (group.state !== "open") throw Error("compare_not_open");
  if (group.summaryThreadId)
    return b.done({ compare: group, summaryThreadId: group.summaryThreadId, created: false });
  if (
    !members.some((m) => state.thread?.some((t) => t.id === m.threadId && t.agentId === profileId))
  )
    throw Error("compare_member_required");
  if (
    state.turn?.some(
      (r) => members.some((m) => m.threadId === r.threadId) && r.status === "running",
    ) ||
    state.interaction?.some(
      (r) => members.some((m) => m.threadId === r.threadId) && r.state === "pending",
    )
  )
    throw Error("compare_answers_not_ready");
  const profile = state.agent?.find((r) => r.id === profileId && !r.archived);
  if (!profile) throw Error("profile_unavailable");
  const definition = state.agentDefinition?.find((r) => r.id === profile.definitionId);
  if ((definition?.staticCapabilities as Record<string, unknown> | undefined)?.readOnly !== true)
    throw Error(`compare_read_only_unavailable: ${String(profile.name)}`);
  const prompt = compareSummaryPrompt(state, id);
  if (prompt !== expectedPrompt) throw Error("compare_answers_changed");
  b.add(
    createScopedChat(
      b.state,
      {
        id: threadId,
        agentId: profileId,
        kind: "side",
        title: `Where they differ · ${group.title}`,
        titleSource: "auto",
        pinned: false,
        archived: false,
        createdAt: context.at,
        lastActivityAt: context.at,
        ...(group.projectId ? { projectId: group.projectId } : {}),
        ...(group.node ? { node: group.node } : {}),
      },
      context,
    ),
  );
  const next = { ...group, summaryThreadId: threadId };
  b.write("compare", next, "updated");
  b.add(
    queueHumanInput(
      b.state,
      { threadId, input: [{ type: "text", text: prompt }], mode: "queue" },
      `${context.commandId}:summary-input`,
      context,
    ),
  );
  return b.done({ compare: next, summaryThreadId: threadId, created: true });
}
