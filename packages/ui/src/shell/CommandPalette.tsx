import { parse, terms, ViewRecordSchema } from "@zoltbot/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import { type Row, text } from "../chat/types.js";
import { Kbd, ListRow } from "../components/primitives.js";
import { routeLabels, routes, useShell } from "../state.js";
import { scopeLabel } from "../workspaces/activity.js";
import { emptyRows } from "../workspaces/view.js";
import { Icon } from "./icons.js";

type Result = { key: string; icon: string; label: string; detail?: string; run(): void };
// Per kind, so one busy workspace cannot push every other kind out of the list.
const perKind = 6;

export function CommandPalette({ entities }: { entities: Record<string, Row[] | undefined> }) {
  const open = useShell((s) => s.palette),
    setOpen = useShell((s) => s.setPalette),
    navigate = useShell((s) => s.navigate),
    openScope = useShell((s) => s.openScope),
    openThread = useShell((s) => s.openThread),
    openQuickChat = useShell((s) => s.openQuickChat),
    setTheme = useShell((s) => s.setTheme),
    activeView = useShell((s) => (s.route === "View" ? s.viewId : undefined));
  const dialog = useRef<HTMLDialogElement>(null),
    input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (open) {
      dialog.current?.showModal();
      input.current?.focus();
    } else {
      dialog.current?.close();
      setQuery("");
    }
  }, [open]);
  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const hit = (value: string) => value.toLowerCase().includes(needle);
    const projects = (entities.project ?? emptyRows).filter((row) => !row.archived),
      directions = (entities.subproject ?? emptyRows).filter((row) => !row.archived);
    const active = entities.view?.find((row) => row.id === activeView);
    const view = active ? parse(ViewRecordSchema, active) : undefined;
    const pages: Result[] = [
      ...(view?.enabled && view.granted.includes("read")
        ? (view.shortcuts ?? []).map((shortcut) => ({
            key: `shortcut:${view.id}:${shortcut.id}`,
            icon: "Projects",
            label: `${view.name}: ${shortcut.label}`,
            detail: shortcut.keys,
            run: () => {
              setOpen(false);
              window.dispatchEvent(
                new CustomEvent("view-shortcut", {
                  detail: { viewId: view.id, shortcutId: shortcut.id },
                }),
              );
            },
          }))
        : []),
      ...(entities.view ?? emptyRows)
        .filter((row) => row.enabled)
        .map((row) => ({
          key: `page:view:${row.id}`,
          icon: "Projects",
          label: String(row.name),
          run: () => useShell.getState().openView(String(row.id)),
        })),
      { key: "page:quick", icon: "Sessions", label: "Quick chat", run: () => openQuickChat() },
      ...[...routes, "Settings", "Doctor", "Rules"].map((name) => ({
        key: `page:${name}`,
        icon: name === "Doctor" || name === "Rules" ? "Settings" : name,
        label:
          name === "Doctor"
            ? "Coding agents"
            : name === "Rules"
              ? "Approval rules"
              : (routeLabels[name as keyof typeof routeLabels] ?? name),
        run: () => navigate(name as (typeof routes)[number]),
      })),
      {
        key: "command:theme",
        icon: "Sun",
        label: "Toggle theme",
        run: () => {
          setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
          setOpen(false);
        },
      },
      {
        key: "command:voice",
        icon: "Mic",
        label: "Voice and dictation settings",
        run: () => navigate("Settings"),
      },
    ].map((page) => ({
      ...page,
      label: page.key.startsWith("page:") ? `Open ${page.label}` : page.label,
    }));
    if (!needle) return pages;
    const scopes: Result[] = [
      ...projects
        .filter((row) => hit(text(row.name)))
        .map((row) => ({
          key: `project:${text(row.id)}`,
          icon: "Projects",
          label: text(row.name),
          detail: terms.workspace.One,
          run: () => openScope({ type: "project", id: text(row.id) }),
        })),
      ...directions
        .filter((row) => hit(text(row.name)))
        .map((row) => ({
          key: `subproject:${text(row.id)}`,
          icon: "Projects",
          label: text(row.name),
          // The team's parent path: "Zolt › Product" for a team inside Product.
          detail: scopeLabel(
            {
              projectId: row.projectId,
              node: row.parentId
                ? { type: "subproject", id: row.parentId }
                : { type: "project", id: row.projectId },
            },
            projects,
            directions,
          ),
          run: () => openScope({ type: "subproject", id: text(row.id) }),
        })),
    ];
    const chats: Result[] = (entities.thread ?? emptyRows)
      .filter((row) => !row.archived && row.kind !== "task" && hit(text(row.title)))
      .sort((a, b) => text(b.lastActivityAt).localeCompare(text(a.lastActivityAt)))
      .slice(0, perKind)
      .map((row) => ({
        key: `thread:${text(row.id)}`,
        icon: "Sessions",
        label: text(row.title) || terms.chat.One,
        detail: scopeLabel(row, projects, directions) || terms.chat.One,
        run: () => openThread(text(row.id)),
      }));
    const tasks: Result[] = (entities.task ?? emptyRows)
      .filter((row) => hit(text(row.title)))
      .slice(0, perKind)
      .map((row) => ({
        key: `task:${text(row.id)}`,
        icon: "Tasks",
        label: text(row.title),
        detail: "Task",
        run: () => (row.threadId ? openThread(text(row.threadId)) : navigate("Tasks")),
      }));
    return [
      ...scopes.slice(0, perKind),
      ...chats,
      ...tasks,
      // Route names still match, so "inbox" finds Needs you.
      ...pages.filter((page) => hit(page.label) || hit(page.key.replace(/^\w+:/, ""))),
    ];
  }, [
    query,
    entities,
    activeView,
    navigate,
    openScope,
    openThread,
    openQuickChat,
    setTheme,
    setOpen,
  ]);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape already closes the dialog; this adds backdrop clicks.
    <dialog
      ref={dialog}
      className="command-dialog"
      aria-label="Search and commands"
      onClose={() => setOpen(false)}
      onClick={(event) => {
        // A click on the backdrop targets the dialog itself, outside its box.
        if (event.target !== event.currentTarget) return;
        const box = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < box.left ||
          event.clientX > box.right ||
          event.clientY < box.top ||
          event.clientY > box.bottom
        )
          setOpen(false);
      }}
    >
      <div className="command-search">
        <Icon name="Search" />
        <input
          ref={input}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && results[0]) {
              event.preventDefault();
              results[0].run();
            }
          }}
          placeholder={`Search ${terms.workspace.many}, ${terms.chat.many}, tasks and pages`}
          aria-label="Search commands"
        />
        <Kbd>Esc</Kbd>
      </div>
      <div className="command-results">
        {results.length ? (
          results.map((result) => (
            <ListRow
              key={result.key}
              icon={result.icon}
              label={result.label}
              trailing={result.detail}
              onClick={result.run}
            />
          ))
        ) : (
          <p className="command-empty">No results for “{query.trim()}”.</p>
        )}
      </div>
      <div className="palette-footer">
        <span>
          {terms.workspace.Many}, {terms.chat.many}, tasks and pages
        </span>
        <span className="sp" />
        <Kbd>↵</Kbd> to open the first result
      </div>
    </dialog>
  );
}
