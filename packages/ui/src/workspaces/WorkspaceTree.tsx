import { terms } from "@zoltbot/protocol";
import { memo, useEffect, useState } from "react";
import { type Row, text } from "../chat/types.js";
import { avatarHue } from "../components/identity.js";
import { Chip, StatusDot, statusLabels } from "../components/primitives.js";
import { Icon } from "../shell/icons.js";
import {
  type ChatStatus,
  type RowStatus,
  rowStatusLabels,
  statusRank,
  threadProject,
} from "./activity.js";
import { chatTitle, unnamedManager } from "./manager-view.js";
import { atScope, type WorkspaceScope } from "./view.js";
import "./workspaces.css";

/** "Zolt Product" → "P": projects often share a company name, so the last word tells them apart. */
export function projectInitial(name: string) {
  return ([...(name.trim().split(/\s+/).at(-1) ?? "")][0] ?? "").toUpperCase();
}

// Chats past this many collapse behind "N older chats" unless they are active or the manager.
const visibleChats = 5;
const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
/** "⌘3" on a Mac, "Ctrl+3" elsewhere. */
export const jumpLabel = (n: number) => (mac ? `⌘${n}` : `Ctrl+${n}`);

/** Chat ids in the order the tree shows them, read from the page so nesting is respected. */
function shownChats() {
  return [...document.querySelectorAll<HTMLElement>(".scope-tree .scope-chat[data-chat]")]
    .map((row) => row.dataset.chat ?? "")
    .slice(0, 9);
}

/**
 * Holding ⌘ (Ctrl elsewhere) for a moment shows 1–9 on the first nine chats; ⌘1–9 opens one.
 * Returns the chats that show a number while the key is held.
 */
function useJumpKeys(onJump: (id: string) => void) {
  const [hints, setHints] = useState<string[]>([]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      clearTimeout(timer);
      setHints([]);
    };
    const down = (event: KeyboardEvent) => {
      const held = mac ? event.metaKey : event.ctrlKey;
      if (event.key === (mac ? "Meta" : "Control")) {
        clearTimeout(timer);
        timer = setTimeout(() => setHints(shownChats()), 200);
        return;
      }
      if (held && !event.altKey && !event.shiftKey && /^[1-9]$/.test(event.key)) {
        const id = shownChats()[Number(event.key) - 1];
        if (!id) return;
        event.preventDefault();
        stop();
        onJump(id);
      } else clearTimeout(timer);
    };
    const up = (event: KeyboardEvent) => {
      if (event.key === (mac ? "Meta" : "Control")) stop();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", stop);
    return () => {
      stop();
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", stop);
    };
  }, [onJump]);
  return hints;
}

export const WorkspaceTree = memo(function WorkspaceTree({
  projects,
  directions,
  threads,
  statuses,
  rows,
  selected,
  currentChat,
  onScope,
  onChat,
}: {
  projects: Row[];
  directions: Row[];
  threads: Row[];
  statuses: Map<string, ChatStatus>;
  /** What each chat row says on its right: Approval, Input, Working, Failed or Done. */
  rows: Map<string, RowStatus>;
  selected: WorkspaceScope | undefined;
  currentChat: string | undefined;
  onScope(scope: WorkspaceScope): void;
  onChat(id: string): void;
}) {
  const [expansion, setExpansion] = useState<Record<string, boolean>>(() => {
      try {
        const saved = JSON.parse(localStorage.getItem("zoltbot.treeExpansion.v1") ?? "{}");
        return Object.fromEntries(
          Object.entries(saved ?? {}).filter(([, value]) => typeof value === "boolean"),
        ) as Record<string, boolean>;
      } catch {
        return {};
      }
    }),
    [expandedOlder, setExpandedOlder] = useState(new Set<string>());
  const status = (thread: Row) => statuses.get(text(thread.id)) ?? "idle";
  const rowStatus = (thread: Row) => rows.get(text(thread.id)) ?? "idle";
  const hints = useJumpKeys(onChat);
  const toggle = (set: typeof setExpandedOlder, key: string) =>
    set((old) => {
      const next = new Set(old);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  let remaining = 200;
  function node(
    scope: WorkspaceScope,
    row: Row,
    depth: number,
  ): { view: React.ReactNode; needs: number; containsCurrent: boolean } {
    if (remaining-- <= 0 || depth > 3) return { view: null, needs: 0, containsCurrent: false };
    const key = `${scope.type}:${scope.id}`;
    const children = directions
      .filter(
        (entry) =>
          !entry.archived &&
          entry.projectId === (scope.type === "project" ? scope.id : row.projectId) &&
          (scope.type === "project" ? !entry.parentId : entry.parentId === scope.id),
      )
      .sort((a, b) => text(a.name).localeCompare(text(b.name)))
      .map((child) => node({ type: "subproject", id: text(child.id) }, child, depth + 1));
    const chats = threads
      // Task conversations open from the Tasks page, so the tree keeps to chats.
      .filter((entry) => !entry.archived && entry.kind !== "task" && atScope(entry, scope))
      .sort(
        (a, b) =>
          Number(b.kind === "manager") - Number(a.kind === "manager") ||
          statusRank[status(a)] - statusRank[status(b)] ||
          text(b.lastActivityAt).localeCompare(text(a.lastActivityAt)),
      );
    const showOlder = expandedOlder.has(key);
    const shown = chats.filter(
      (chat, index) =>
        showOlder || index < visibleChats || chat.kind === "manager" || status(chat) !== "idle",
    );
    const older = chats.length - shown.length;
    // The manager is the team's lead, so the count matches "N chats" on the overview.
    const members = chats.filter((chat) => chat.kind !== "manager").length;
    const needs =
      chats.filter((chat) => status(chat) === "needs_you").length +
      children.reduce((sum, child) => sum + child.needs, 0);
    const expandable = children.length > 0 || chats.length > 0;
    const isSelected = selected?.type === scope.type && selected.id === scope.id;
    const containsCurrent =
      isSelected ||
      chats.some((chat) => chat.id === currentChat) ||
      children.some((child) => child.containsCurrent);
    const expanded = expansion[key] ?? containsCurrent;
    const view = (
      <li key={key}>
        <div className={`scope-tree-row${scope.type === "project" ? " project" : ""}`}>
          {expandable ? (
            <button
              type="button"
              className="scope-toggle"
              aria-label={`${expanded ? "Collapse" : "Expand"} ${text(row.name)}`}
              aria-expanded={expanded}
              onClick={() =>
                setExpansion((old) => {
                  const next = { ...old, [key]: !expanded };
                  try {
                    localStorage.setItem("zoltbot.treeExpansion.v1", JSON.stringify(next));
                  } catch {}
                  return next;
                })
              }
            >
              <Icon name={expanded ? "ChevronDown" : "ChevronRight"} size="sm" />
            </button>
          ) : (
            <span className="scope-toggle-spacer" />
          )}
          <button
            type="button"
            className={`item scope-node${isSelected ? " on" : ""}`}
            aria-current={isSelected ? "page" : undefined}
            onClick={() => onScope(scope)}
            title={text(row.name)}
            aria-description={needs ? `${needs} ${needs === 1 ? "needs" : "need"} you` : undefined}
          >
            {scope.type === "project" ? (
              <span className={`scope-project-mark h${avatarHue(scope.id)}`} aria-hidden="true">
                {projectInitial(text(row.name))}
              </span>
            ) : null}
            <bdi className="truncate grow">{text(row.name)}</bdi>
            {needs ? (
              <span aria-hidden="true">
                <Chip tone="attention">{needs}</Chip>
              </span>
            ) : scope.type === "subproject" && members ? (
              <span className="scope-count" aria-hidden="true">
                {members}
              </span>
            ) : null}
          </button>
        </div>
        {expandable && expanded ? (
          <ul>
            {shown.map((chat) => {
              const id = text(chat.id),
                current = currentChat === id,
                title = chatTitle(chat, text(row.name)),
                // A renamed manager keeps a badge; an unnamed one already says "manager".
                badge = chat.kind === "manager" && !unnamedManager(chat);
              if (remaining <= 0) return null;
              remaining--;
              const jump = hints.indexOf(id) + 1;
              return (
                <li key={id}>
                  <button
                    type="button"
                    className={`item scope-chat ${status(chat)} row-${rowStatus(chat)}${current ? " on" : ""}`}
                    aria-current={current ? "page" : undefined}
                    onClick={() => {
                      onScope(scope);
                      onChat(id);
                    }}
                    title={title}
                    data-chat={id}
                    aria-description={[
                      badge ? terms.manager.One : "",
                      rowStatusLabels[rowStatus(chat)] || statusLabels[status(chat)],
                    ]
                      .filter(Boolean)
                      .join(", ")
                      .toLowerCase()}
                  >
                    <StatusDot
                      status={rowStatus(chat) === "failed" ? "error" : status(chat)}
                      label={false}
                    />
                    <bdi className="truncate grow">{title}</bdi>
                    {badge ? (
                      <span className="scope-lead" aria-hidden="true">
                        {terms.manager.One}
                      </span>
                    ) : null}
                    {jump ? (
                      <span className="scope-jump" aria-hidden="true">
                        {jumpLabel(jump)}
                      </span>
                    ) : rowStatus(chat) !== "idle" ? (
                      <span className={`scope-state ${rowStatus(chat)}`} aria-hidden="true">
                        {rowStatusLabels[rowStatus(chat)]}
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
            {older > 0 || (showOlder && chats.length > visibleChats) ? (
              <li>
                <button
                  type="button"
                  className="item scope-older"
                  aria-expanded={showOlder}
                  onClick={() => toggle(setExpandedOlder, key)}
                >
                  {showOlder
                    ? `Show fewer ${terms.chat.many}`
                    : `${older} older ${older === 1 ? terms.chat.one : terms.chat.many}`}
                </button>
              </li>
            ) : null}
            {children.map((child) => child.view)}
          </ul>
        ) : null}
      </li>
    );
    return { view, needs, containsCurrent };
  }
  // Workspaces with the most recent chat activity come first, as in the launch rule.
  const latest = new Map<string, string>();
  for (const thread of threads) {
    const id = threadProject(thread, directions),
      at = text(thread.lastActivityAt);
    if (id && at > (latest.get(id) ?? "")) latest.set(id, at);
  }
  const recency = (row: Row) => latest.get(text(row.id)) ?? text(row.createdAt);
  const active = projects
    .filter((row) => !row.archived)
    .sort(
      (a, b) => recency(b).localeCompare(recency(a)) || text(a.name).localeCompare(text(b.name)),
    );
  return active.length ? (
    <ul className="scope-tree">
      {active
        .slice(0, 100)
        .map((project) => node({ type: "project", id: text(project.id) }, project, 0).view)}
    </ul>
  ) : (
    <p className="tree-empty">
      Your {terms.workspace.many}, {terms.team.many} and {terms.chat.many} will appear here.
    </p>
  );
});
