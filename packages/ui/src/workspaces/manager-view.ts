import { terms } from "@zoltbot/protocol";
import { body, type Row, text } from "../chat/types.js";
import { groupTasks, type TaskGroup } from "../tasks/view.js";
import type { ChatStatus } from "./activity.js";
import { object, type WorkspaceScope } from "./view.js";

/** A chat's status in the overview: a queued message counts once nothing more urgent applies. */
export type MemberStatus = ChatStatus | "queued";
export const memberOrder: MemberStatus[] = ["needs_you", "working", "queued", "done", "idle"];
const memberRank = (status: MemberStatus) => memberOrder.indexOf(status);
const rowCap = 100;

/** Team rows by id, so walking up the tree does not rescan the list at each step. */
export function teamIndex(teams: Row[]) {
  return new Map(teams.map((row) => [text(row.id), row]));
}

/**
 * Whether a node is at the scope or anywhere below it. A team is below a team when walking
 * parentId up reaches it, and below a workspace when it belongs to that workspace.
 */
export function withinScope(
  node: unknown,
  scope: WorkspaceScope,
  teams: Map<string, Row>,
): boolean {
  const value = object(node),
    id = text(value.id);
  if (!id) return false;
  if (value.type === "project") return scope.type === "project" && id === scope.id;
  if (value.type !== "subproject") return false;
  if (scope.type === "project") return text(teams.get(id)?.projectId) === scope.id;
  const seen = new Set<string>();
  for (let at = id; at && !seen.has(at); at = text(teams.get(at)?.parentId)) {
    if (at === scope.id) return true;
    seen.add(at);
    if (!teams.has(at)) return false;
  }
  return false;
}

/** Strictly below: within the scope but not the scope itself. */
export function belowScope(node: unknown, scope: WorkspaceScope, teams: Map<string, Row>) {
  const value = object(node);
  return !(value.type === scope.type && value.id === scope.id) && withinScope(node, scope, teams);
}

/** Threads with a message still waiting in the input queue. */
export function queuedThreads(items: Row[]) {
  const result = new Set<string>();
  for (const row of items)
    if (row.kind === "user" && body(row).queueState === "queued") result.add(text(row.threadId));
  return result;
}

export function memberStatus(
  id: string,
  statuses: Map<string, ChatStatus>,
  queued: Set<string>,
): MemberStatus {
  const status = statuses.get(id) ?? "idle";
  return status === "needs_you" || status === "working" || !queued.has(id) ? status : "queued";
}

export type ContextPart = { label: string; value: string };
export type ContextLayer = {
  key: string;
  /** "Workspace", "Team" or "Profile". */
  source: string;
  name: string;
  parts: ContextPart[];
};

/**
 * What a manager starts with, in the order it receives it: the workspace, each parent team,
 * this team, then the profile's own instructions.
 */
export function managerContext(
  project: Row,
  chain: Row[],
  profile: Row | undefined,
): ContextLayer[] {
  const parts = (row: Row, fields: [keyof Row, string][]) =>
    fields.flatMap(([field, label]) =>
      text(row[field]).trim() ? [{ label, value: text(row[field]).trim() }] : [],
    );
  const layers: ContextLayer[] = [
    {
      key: `project:${text(project.id)}`,
      source: terms.workspace.One,
      name: text(project.name),
      parts: parts(project, [
        ["goal", "Goal"],
        ["instructions", "Instructions"],
        ["constraints", "Constraints"],
      ]),
    },
    ...chain.map((row) => ({
      key: `subproject:${text(row.id)}`,
      source: terms.team.One,
      name: text(row.name),
      parts: parts(row, [
        ["goal", "Goal"],
        ["instructions", "Instructions"],
      ]),
    })),
  ];
  if (profile)
    layers.push({
      key: `agent:${text(profile.id)}`,
      source: terms.profile.One,
      name: text(profile.name),
      parts: parts(profile, [["instructions", "Instructions"]]),
    });
  return layers;
}

/** Total characters in a context, to decide whether it starts collapsed. */
export function contextLength(layers: ContextLayer[]) {
  return layers.reduce(
    (sum, layer) => sum + layer.parts.reduce((total, part) => total + part.value.length, 0),
    0,
  );
}

export type TeamMember = {
  id: string;
  name: string;
  /** Names of the teams between this one and the scope, for nested teams. */
  path: string[];
  managerName: string;
  managerThreadId: string | undefined;
  status: MemberStatus;
  counts: Record<MemberStatus, number>;
};
export type ChatMember = {
  id: string;
  title: string;
  profileName: string;
  /** The team the chat is in when that is below the scope, otherwise "". */
  teamName: string;
  status: MemberStatus;
};

export type MemberInputs = {
  teams: Row[];
  threads: Row[];
  profiles: Row[];
  statuses: Map<string, ChatStatus>;
  queued: Set<string>;
};

const emptyCounts = (): Record<MemberStatus, number> => ({
  needs_you: 0,
  working: 0,
  queued: 0,
  done: 0,
  idle: 0,
});

/** Every team and chat below the scope, most urgent first, each capped. */
export function teamBelow(scope: WorkspaceScope, input: MemberInputs) {
  const index = teamIndex(input.teams.filter((row) => !row.archived));
  const profileName = (id: unknown) =>
    text(input.profiles.find((row) => row.id === id)?.name) || "Saved profile";
  const status = (id: string) => memberStatus(id, input.statuses, input.queued);
  const pathTo = (row: Row) => {
    const names: string[] = [],
      seen = new Set<string>();
    for (
      let id = text(row.parentId);
      id && id !== scope.id && !seen.has(id);
      id = text(index.get(id)?.parentId)
    ) {
      seen.add(id);
      names.unshift(text(index.get(id)?.name));
    }
    return names.filter(Boolean);
  };
  const threads = input.threads.filter((row) => !row.archived && row.kind !== "task");
  const teams: TeamMember[] = [];
  for (const row of index.values()) {
    const id = text(row.id),
      node = { type: "subproject", id };
    if (!belowScope(node, scope, index)) continue;
    const self: WorkspaceScope = { type: "subproject", id },
      counts = emptyCounts();
    let manager: Row | undefined,
      lead: MemberStatus = "idle";
    for (const thread of threads) {
      if (!withinScope(thread.node, self, index)) continue;
      const at = object(thread.node),
        current = status(text(thread.id));
      // Managers are leads, not chats: they colour the team's status but are not counted.
      if (thread.kind !== "manager") counts[current]++;
      else if (memberRank(current) < memberRank(lead)) lead = current;
      if (thread.kind === "manager" && at.type === "subproject" && at.id === id) manager = thread;
    }
    teams.push({
      id,
      name: text(row.name),
      path: pathTo(row),
      managerName: manager ? profileName(manager.agentId) : "",
      managerThreadId: manager ? text(manager.id) : undefined,
      status:
        memberOrder.find((key) => key !== "idle" && (counts[key] > 0 || lead === key)) ?? "idle",
      counts,
    });
  }
  const chats: ChatMember[] = [];
  for (const thread of threads) {
    if (thread.kind === "manager" || !withinScope(thread.node, scope, index)) continue;
    const at = object(thread.node);
    chats.push({
      id: text(thread.id),
      title: text(thread.title),
      profileName: profileName(thread.agentId),
      teamName:
        at.type === "subproject" && at.id !== scope.id ? text(index.get(text(at.id))?.name) : "",
      status: status(text(thread.id)),
    });
  }
  teams.sort(
    (a, b) =>
      memberRank(a.status) - memberRank(b.status) ||
      [...a.path, a.name].join("/").localeCompare([...b.path, b.name].join("/")),
  );
  const activity = new Map(threads.map((row) => [text(row.id), text(row.lastActivityAt)]));
  const pinnedIds = new Set(
    threads.filter((row) => Boolean(row.pinned)).map((row) => text(row.id)),
  );
  chats.sort(
    (a, b) =>
      Number(pinnedIds.has(b.id)) - Number(pinnedIds.has(a.id)) ||
      memberRank(a.status) - memberRank(b.status) ||
      (activity.get(b.id) ?? "").localeCompare(activity.get(a.id) ?? ""),
  );
  return {
    teams: teams.slice(0, rowCap),
    chats: chats.slice(0, rowCap),
    totalTeams: teams.length,
    totalChats: chats.length,
  };
}

/** Tasks and routines whose node is the scope or below it. */
export function teamWork(scope: WorkspaceScope, tasks: Row[], routines: Row[], teams: Row[]) {
  const index = teamIndex(teams);
  const mine = tasks.filter((row) => !row.archived && withinScope(row.node, scope, index));
  const groups = groupTasks(mine, true);
  const counts = Object.fromEntries(
    (Object.keys(groups) as TaskGroup[]).map((key) => [key, groups[key].length]),
  ) as Record<TaskGroup, number>;
  for (const key of Object.keys(groups) as TaskGroup[]) groups[key] = groups[key].slice(0, 5);
  const scheduled = routines
    .filter((row) => withinScope(object(row.template).node, scope, index))
    .sort(
      (a, b) =>
        Number(a.paused === true) - Number(b.paused === true) ||
        text(a.nextRunAt).localeCompare(text(b.nextRunAt)),
    );
  return { groups, counts, total: mine.length, routines: scheduled.slice(0, 20) };
}

export type ActivityEntry = {
  id: string;
  kind: "delegate" | "report" | "needs_you";
  text: string;
  /** The chat to open for this entry. */
  threadId: string;
  at: string;
};

/** "Video creator" for a chat; a manager reads as its profile name unless it was renamed. */
export function threadName(thread: Row | undefined, profiles: Row[]) {
  if (!thread) return `a ${terms.chat.one} that was removed`;
  if (unnamedManager(thread))
    return text(profiles.find((row) => row.id === thread.agentId)?.name) || terms.manager.One;
  return text(thread.title).trim() || `Untitled ${terms.chat.one}`;
}

/** Whether a manager chat still has the title it was created with, so it has no name of its own. */
export function unnamedManager(thread: Row) {
  const title = text(thread.title).trim();
  return thread.kind === "manager" && (!title || title === terms.manager.One);
}

/** "Food logging manager" for an unnamed manager chat, otherwise the chat's own title. */
export function chatTitle(thread: Row, scopeName: string) {
  return unnamedManager(thread)
    ? `${scopeName} ${terms.manager.one}`.trim()
    : text(thread.title) || `Untitled ${terms.chat.one}`;
}

/**
 * Briefs, reports and open requests that involve this manager or any chat below it, newest
 * first. Briefs and reports from another manager name that manager.
 */
export function recentActivity(
  scope: WorkspaceScope,
  managerThreadId: string | undefined,
  input: {
    audits: Row[];
    interactions: Row[];
    threads: Row[];
    profiles: Row[];
    teams: Row[];
  },
  limit = 20,
): ActivityEntry[] {
  const index = teamIndex(input.teams),
    byId = new Map(input.threads.map((row) => [text(row.id), row]));
  const involved = new Set(
    input.threads.filter((row) => withinScope(row.node, scope, index)).map((row) => text(row.id)),
  );
  if (managerThreadId) involved.add(managerThreadId);
  const name = (id: string) => threadName(byId.get(id), input.profiles);
  const entries: ActivityEntry[] = [];
  for (const row of input.audits) {
    const detail = object(row.detail),
      manager = text(detail.managerThreadId),
      target = text(row.target);
    if (row.action === "manager.delegate") {
      if (!involved.has(manager) && !involved.has(target)) continue;
      const by = manager === managerThreadId ? "" : `${name(manager)} `;
      entries.push({
        id: text(row.id),
        kind: "delegate",
        text: `${by ? `${by}briefed` : "Briefed"} ${name(target)}`,
        threadId: target,
        at: text(row.at),
      });
    } else if (row.action === "team.report") {
      const from = text(detail.fromThreadId);
      if (!involved.has(manager || target) && !involved.has(from)) continue;
      const to = manager || target;
      entries.push({
        id: text(row.id),
        kind: "report",
        text: `Report from ${name(from)}${to === managerThreadId ? "" : ` to ${name(to)}`}`,
        threadId: to,
        at: text(row.at),
      });
    }
  }
  for (const row of input.interactions)
    if (row.state === "pending" && involved.has(text(row.threadId)))
      entries.push({
        id: text(row.id),
        kind: "needs_you",
        text: `${name(text(row.threadId))} needs you`,
        threadId: text(row.threadId),
        at: text(row.createdAt),
      });
  return entries.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}
