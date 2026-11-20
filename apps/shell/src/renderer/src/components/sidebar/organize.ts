// S9: the order of the sidebar's chats. Pure functions, so the rules are tested without a
// renderer; Sidebar.tsx draws the result.
import type { BotProfile } from "../../data";
import { t } from "../../i18n";

export type SidebarSort = "recent" | "name";

/** Every project, or one project's chats; null is the chats outside any project. */
export type ProjectFilter = { kind: "all" } | { kind: "project"; projectId: string | null };

export const ALL_PROJECTS: ProjectFilter = { kind: "all" };

export interface Arranged {
  /** Shown first, under Unread, when sorting by recent activity. */
  unread: BotProfile[];
  rest: BotProfile[];
}

const byRecent = (a: BotProfile, b: BotProfile) =>
  (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
const byName = (a: BotProfile, b: BotProfile) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });

/**
 * Filters to a project, pulls unread chats into their own group, then sorts what's left. Projects
 * keep their order, and agents keep the company's order, so only plain chats move; pinned chats
 * go first among them.
 */
export function arrangeBots(
  bots: readonly BotProfile[],
  options: { sort: SidebarSort; project: ProjectFilter; isUnread: (bot: BotProfile) => boolean },
): Arranged {
  const { project } = options;
  const shown =
    project.kind === "all"
      ? bots
      : bots.filter((bot) => (bot.projectId ?? null) === project.projectId);
  const unread = options.sort === "recent" ? shown.filter(options.isUnread).sort(byRecent) : [];
  const taken = new Set(unread.map((bot) => bot.id));
  const groups = new Map<string, BotProfile[]>();
  for (const bot of shown) {
    if (taken.has(bot.id)) continue;
    const key = bot.projectId ?? "";
    groups.set(key, [...(groups.get(key) ?? []), bot]);
  }
  const compare = options.sort === "name" ? byName : byRecent;
  const rest = [...groups.values()].flatMap((group) => {
    const agents = group.filter((bot) => bot.companyRole && bot.companyRole !== "chat");
    const chats = group
      .filter((bot) => !bot.companyRole || bot.companyRole === "chat")
      .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || compare(a, b));
    return [...agents, ...chats];
  });
  return { unread, rest };
}

export interface GroupHeading {
  projectId: string | null;
  name: string;
  title: string | undefined;
}

/**
 * The heading above row `index`, if a group starts there: Unread first, then one where the
 * project changes. `at` reads the bot on a row.
 */
export function groupHeadingAt(
  at: (index: number) => BotProfile | undefined,
  index: number,
  unreadCount: number,
): GroupHeading | undefined {
  if (index < unreadCount)
    return index === 0
      ? { projectId: null, name: t("sidebar.group.unread"), title: undefined }
      : undefined;
  const bot = at(index);
  const previous = index > unreadCount ? at(index - 1) : undefined;
  if (!bot || (previous && (previous.projectId ?? null) === (bot.projectId ?? null)))
    return undefined;
  if (bot.projectId)
    return { projectId: bot.projectId, name: bot.projectName || "Project", title: bot.projectName };
  return previous || unreadCount > 0
    ? { projectId: null, name: t("sidebar.group.chats"), title: t("sidebar.group.chatsTitle") }
    : undefined;
}

/** The projects the chats belong to, in sidebar order, for the filter menu. */
export function projectsOf(bots: readonly BotProfile[]): { id: string | null; name: string }[] {
  const seen = new Map<string | null, string>();
  for (const bot of bots) {
    const id = bot.projectId ?? null;
    if (!seen.has(id))
      seen.set(id, id ? bot.projectName || "Project" : t("sidebar.sort.noProject"));
  }
  return [...seen.entries()].map(([id, name]) => ({ id, name }));
}
