import {
  type Channel,
  type ChannelPost,
  type ChannelRead,
  ChannelSchema,
  type ChannelWaiting,
  type DomainEvent,
  type EntityKind,
  entitySchemas,
  parse,
  parseEvent,
} from "@zoltbot/protocol";
import type { CommandContext, Outcome } from "./commands.js";
import type { DomainState } from "./projectors.js";

/**
 * Team channels. Each team with a manager gets a channel led by that manager, and each project
 * with a CEO gets a project-wide channel led by the CEO. Members follow the team: its manager,
 * the chats placed in the team, the employees working on tasks the manager is accountable for,
 * and the managers of teams directly below it.
 */
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const finalTaskStates = ["completed", "cancelled", "failed"];
type Row = Record<string, unknown>;

export function channelEvent(
  kind: EntityKind,
  value: Row,
  context: CommandContext,
  verb: "created" | "updated",
  index: number,
): DomainEvent {
  parse(entitySchemas[kind], value);
  return parseEvent({
    eventId: `${context.commandId}:${index}`,
    commandId: context.commandId,
    aggregateType: kind,
    aggregateId: String(value.id),
    type: `${kind}.${verb}`,
    occurredAt: context.at,
    payload: value,
  });
}
/** Gives every event in a combined outcome its own id under this command. */
export function renumberEvents(events: DomainEvent[], context: CommandContext): DomainEvent[] {
  return events.map((event, index) => ({
    ...event,
    commandId: context.commandId,
    eventId: `${context.commandId}:${index}`,
  }));
}

/** A channel name from a team name: lower case, words joined by dashes. */
export function channelSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "team";
}
export const channelId = {
  team: (teamId: string) => `channel-team-${teamId}`,
  project: (projectId: string) => `channel-project-${projectId}`,
};

function liveAgent(state: DomainState, agentId: unknown): boolean {
  return !!state.agent?.some((row) => row.id === agentId && !row.archived && !row.hidden);
}
function nodeIs(row: Row, type: string, id: string): boolean {
  const node = row.node as { type?: string; id?: string } | undefined;
  return node?.type === type && node.id === id;
}
/** A task chat counts as a member while its task is still open. */
function activeChat(state: DomainState, row: Row): boolean {
  if (row.kind !== "task") return true;
  const task = state.task?.find((t) => t.threadId === row.id || t.id === row.taskId);
  return !task || !finalTaskStates.includes(text(task.state));
}

type Desired = Omit<Channel, "createdAt" | "updatedAt" | "archivedAt">;
/** The channels each project should have now, with their leads and members. */
export function desiredChannels(state: DomainState): Desired[] {
  const out: Desired[] = [];
  for (const project of state.project ?? []) {
    if (project.archived) continue;
    const projectId = text(project.id);
    const chats = (state.thread ?? []).filter(
      (row) =>
        row.projectId === projectId && !row.archived && !row.fork && liveAgent(state, row.agentId),
    );
    const managers = chats.filter((row) => row.kind === "manager");
    const ceo = managers.find((row) => nodeIs(row, "project", projectId));
    const teams = (state.subproject ?? [])
      .filter((row) => row.projectId === projectId && !row.archived)
      .sort(
        (a, b) =>
          text(a.createdAt).localeCompare(text(b.createdAt)) ||
          text(a.id).localeCompare(text(b.id)),
      );
    const managerOf = (teamId: string) => managers.find((row) => nodeIs(row, "subproject", teamId));
    const used = new Set<string>();
    const unique = (base: string) => {
      let name = base;
      for (let n = 2; used.has(name); n++) name = `${base}-${n}`;
      used.add(name);
      return name;
    };
    const members = (lead: Row, placed: (row: Row) => boolean, extra: Row[]) => {
      const accountable = new Set(
        (state.task ?? [])
          .filter(
            (t) => t.accountableThreadId === lead.id && !finalTaskStates.includes(text(t.state)),
          )
          .map((t) => text(t.threadId)),
      );
      const ids = chats
        .filter(
          (row) =>
            row.id !== lead.id &&
            row.kind !== "manager" &&
            activeChat(state, row) &&
            (placed(row) || accountable.has(text(row.id))),
        )
        .concat(extra)
        .map((row) => text(row.id));
      return [text(lead.id), ...[...new Set(ids)].filter((id) => id !== lead.id).sort()];
    };
    if (ceo) used.add("general");
    for (const team of teams) {
      const lead = managerOf(text(team.id));
      if (!lead) continue;
      const below = teams
        .filter((row) => row.parentId === team.id)
        .map((row) => managerOf(text(row.id)))
        .filter((row): row is Row => !!row);
      out.push({
        id: channelId.team(text(team.id)),
        projectId,
        teamId: text(team.id),
        kind: "team",
        name: unique(channelSlug(text(team.name))),
        leadThreadId: text(lead.id),
        memberThreadIds: members(lead, (row) => nodeIs(row, "subproject", text(team.id)), below),
      });
    }
    if (ceo)
      out.push({
        id: channelId.project(projectId),
        projectId,
        kind: "project",
        name: "general",
        leadThreadId: text(ceo.id),
        memberThreadIds: members(
          ceo,
          (row) => nodeIs(row, "project", projectId),
          managers.filter((row) => row.id !== ceo.id),
        ),
      });
  }
  return out;
}
const same = (a: Row, b: Desired) =>
  a.name === b.name &&
  a.leadThreadId === b.leadThreadId &&
  a.teamId === b.teamId &&
  JSON.stringify(a.memberThreadIds) === JSON.stringify(b.memberThreadIds) &&
  !a.archivedAt;
/**
 * Creates missing channels, keeps leads, names and members in step with the teams, and
 * archives a channel whose team lost its manager. Returns no events when nothing changed.
 */
export function syncChannels(state: DomainState, context: CommandContext): Outcome {
  const events: DomainEvent[] = [];
  const desired = desiredChannels(state);
  const wanted = new Set(desired.map((row) => row.id));
  for (const want of desired) {
    const current = state.channel?.find((row) => row.id === want.id);
    if (current && same(current, want)) continue;
    const { teamId, ...rest } = want;
    const value = {
      ...rest,
      ...(teamId ? { teamId } : {}),
      createdAt: text(current?.createdAt) || context.at,
      updatedAt: context.at,
    };
    events.push(channelEvent("channel", value, context, current ? "updated" : "created", 0));
  }
  for (const current of state.channel ?? []) {
    if (wanted.has(text(current.id)) || current.archivedAt) continue;
    events.push(
      channelEvent(
        "channel",
        { ...current, archivedAt: context.at, updatedAt: context.at },
        context,
        "updated",
        0,
      ),
    );
  }
  return {
    events: renumberEvents(events, context),
    result: { changed: events.map((event) => event.aggregateId) },
  };
}

export function liveChannel(state: DomainState, id: string): Channel {
  const row = state.channel?.find((entry) => entry.id === id);
  if (!row || row.archivedAt) throw new Error("channel_unavailable");
  return parse(ChannelSchema, row);
}
/** How a member shows in a channel: a manager by its chat's title, an employee by its name. */
export function memberName(state: DomainState, threadId: string): string {
  const row = state.thread?.find((entry) => entry.id === threadId);
  if (!row) return "Someone";
  const agent = state.agent?.find((entry) => entry.id === row.agentId);
  if (row.kind === "task" && text(agent?.name)) return text(agent?.name);
  return text(row.title) || "Someone";
}
/**
 * Names a member can be @mentioned by, each mapped to one chat. When an employee has several
 * chats in the channel, its name reaches the one active most recently.
 */
export function mentionTargets(state: DomainState, channel: Channel): Map<string, string> {
  const byName = new Map<string, { id: string; at: string }>();
  for (const id of channel.memberThreadIds) {
    const name = memberName(state, id).toLowerCase();
    const at = text(state.thread?.find((row) => row.id === id)?.lastActivityAt);
    const prior = byName.get(name);
    if (!prior || at > prior.at || (id === channel.leadThreadId && at === prior.at))
      byName.set(name, { id, at });
  }
  return new Map([...byName].map(([name, value]) => [name, value.id]));
}
const escapePattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Members named with @Name in the text, plus explicit mentions given as chat ids or names. */
export function resolveMentions(
  state: DomainState,
  channel: Channel,
  body: string,
  explicit: readonly string[] = [],
): string[] {
  const targets = mentionTargets(state, channel);
  const found: string[] = [];
  for (const value of explicit) {
    const id = channel.memberThreadIds.includes(value)
      ? value
      : targets.get(value.replace(/^@/, "").trim().toLowerCase());
    if (!id) throw new Error("mention_not_member");
    found.push(id);
  }
  // Longer names first, so "@Mira Chen" wins over "@Mira".
  for (const [name, id] of [...targets].sort((a, b) => b[0].length - a[0].length)) {
    const pattern = new RegExp(
      `(^|[^\\p{L}\\p{N}_])@${escapePattern(name)}(?![\\p{L}\\p{N}_])`,
      "iu",
    );
    if (pattern.test(body)) found.push(id);
  }
  return [...new Set(found)];
}

/** Questions posted in the channel that a recipient has not answered with a later post yet. */
export function channelWaiting(state: DomainState, channelIdValue: string): ChannelWaiting[] {
  const posts = (state.channelPost ?? [])
    .filter((row) => row.channelId === channelIdValue)
    .sort((a, b) => text(a.createdAt).localeCompare(text(b.createdAt))) as ChannelPost[];
  const closed = new Set(
    (state.channelRequest ?? [])
      .filter((row) => ["stopped", "archived", "done"].includes(text(row.state)))
      .map((row) => text(row.id)),
  );
  const members = new Set(
    (state.channel?.find((row) => row.id === channelIdValue)?.memberThreadIds as string[]) ?? [],
  );
  const out: ChannelWaiting[] = [];
  posts.forEach((post, index) => {
    if (!post.question || (post.requestId && closed.has(post.requestId))) return;
    for (const threadId of post.recipients) {
      if (!members.has(threadId)) continue;
      const answered = posts
        .slice(index + 1)
        .some((later) => later.author.kind === "thread" && later.author.threadId === threadId);
      if (!answered)
        out.push({ postId: post.id, threadId, askedBy: post.author, since: post.createdAt });
    }
  });
  return out;
}

/** The channel's transcript: its newest posts, its requests, their tasks and open questions. */
export function readChannel(state: DomainState, id: string, limit = 200): ChannelRead {
  const row = state.channel?.find((entry) => entry.id === id);
  if (!row) throw new Error("not_found: channel");
  const channel = parse(ChannelSchema, row);
  const all = (state.channelPost ?? [])
    .filter((entry) => entry.channelId === id)
    .sort((a, b) => text(a.createdAt).localeCompare(text(b.createdAt))) as ChannelPost[];
  const requests = (state.channelRequest ?? [])
    .filter((entry) => entry.channelId === id)
    .sort((a, b) => text(a.createdAt).localeCompare(text(b.createdAt)));
  const requestIds = new Set(requests.map((entry) => text(entry.id)));
  const tasks = (state.task ?? [])
    .filter((task) => requestIds.has(text(task.requestId)))
    .map((task) => ({
      id: text(task.id),
      requestId: text(task.requestId),
      title: text(task.title),
      state: text(task.state),
      ...(task.threadId ? { threadId: text(task.threadId) } : {}),
      createdAt: text(task.createdAt),
      updatedAt: text(task.updatedAt),
    }));
  return {
    channel,
    posts: all.slice(-limit),
    requests: requests as ChannelRead["requests"],
    tasks,
    waiting: channelWaiting(state, id),
    more: all.length > limit,
  };
}
