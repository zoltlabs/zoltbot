import { terms } from "@zoltbot/protocol";
import { useEffect, useRef, useState } from "react";
import { type ChatConnection, text } from "../chat/types.js";
import { useShell } from "../state.js";
import { CreationForm, type CreationMode } from "./CreationForm.js";
import { atScope, emptyRows, scopeView } from "./view.js";
import { WorkspaceHome } from "./WorkspaceHome.js";
import { WorkspacesIntro } from "./WorkspacesIntro.js";
import "./workspaces.css";

export default function Workspaces({ connection }: { connection: ChatConnection }) {
  const scope = useShell((state) => state.scope),
    openScope = useShell((state) => state.openScope),
    openThread = useShell((state) => state.openThread);
  const rows = connection.snapshot.entities,
    projects = rows.project ?? emptyRows,
    directions = rows.subproject ?? emptyRows;
  const selected = scopeView(projects, directions, scope);
  const profiles = (rows.agent ?? emptyRows)
    .filter((row) => !row.archived && !row.hidden)
    .slice(0, 100);
  const chats = (rows.thread ?? emptyRows).filter(
    (row) => !row.archived && row.kind !== "task" && scope && atScope(row, scope),
  );
  const manager = chats.find((row) => row.kind === "manager");
  const [creating, setCreating] = useState<CreationMode | undefined>(),
    [focusReturn, setFocusReturn] = useState(0),
    [details, setDetails] = useState(false);
  const detailsButton = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null),
    trigger = useRef<HTMLButtonElement | undefined>(undefined);
  useEffect(() => {
    setCreating(undefined);
    setDetails(false);
    if (scope) heading.current?.focus();
  }, [scope]);
  useEffect(() => {
    if (focusReturn) trigger.current?.focus();
  }, [focusReturn]);
  const online = connection.status === "online",
    depth = selected?.directions.length ?? 0;
  const begin = (mode: CreationMode, button: HTMLButtonElement) => {
    trigger.current = button;
    setCreating(mode);
  };
  const empty = !selected && !projects.some((row) => !row.archived);
  return (
    <section className="workspaces-page" aria-label={terms.workspace.Many}>
      {empty && !creating ? (
        <WorkspacesIntro disabled={!online} onCreate={(button) => begin("workspace", button)} />
      ) : null}
      <header className="scope-heading" hidden={empty && !creating}>
        <div>
          {selected?.directions.length ? (
            <p className="scope-breadcrumb dim">
              {[selected.project, ...selected.directions].map((row, index) => (
                <span key={text(row.id)}>
                  {index ? <span aria-hidden="true"> / </span> : null}
                  <bdi>{text(row.name)}</bdi>
                </span>
              ))}
            </p>
          ) : null}
          <h1 ref={heading} tabIndex={-1}>
            {selected ? <bdi>{text(selected.current.name)}</bdi> : terms.workspace.Many}
          </h1>
          {selected ? (
            <p className="dim scope-root">{rootLabel(selected.project)}</p>
          ) : (
            <p className="dim">
              Each {terms.workspace.one} is a code folder and the {terms.chat.many} working in it.
            </p>
          )}
        </div>
        <div className="r wrap">
          {selected ? (
            <button
              ref={detailsButton}
              type="button"
              className="btn"
              aria-expanded={details}
              onClick={() => setDetails((value) => !value)}
            >
              Details
            </button>
          ) : null}
          <button
            type="button"
            className="btn"
            disabled={!online || !!creating}
            onClick={(event) => begin("workspace", event.currentTarget)}
          >
            New {terms.workspace.one}
          </button>
        </div>
      </header>
      {creating ? (
        <CreationForm
          key={`${creating}:${scope?.id ?? "root"}`}
          mode={creating}
          connection={connection}
          scope={scope}
          projectId={text(selected?.project.id) || undefined}
          parentDepth={depth}
          profiles={profiles}
          defaultProfile={
            [text(selected?.project.defaultAgentId), text(manager?.agentId)].find((id) =>
              profiles.some((row) => row.id === id),
            ) || text((profiles.find((p) => p.template !== "artifact_designer") ?? profiles[0])?.id)
          }
          onCancel={() => {
            setCreating(undefined);
            setFocusReturn((value) => value + 1);
          }}
          onDone={(kind, id) => {
            setCreating(undefined);
            if (kind === "thread") openThread(id);
            else openScope({ type: kind, id });
          }}
        />
      ) : null}
      {selected && scope ? (
        <WorkspaceHome
          key={`${scope.type}:${scope.id}`}
          connection={connection}
          scope={scope}
          project={selected.project}
          manager={manager}
          profiles={profiles}
          canAssign={online && !creating && profiles.length > 0}
          canAddTeam={online && !creating && depth < 3}
          onCreate={begin}
          details={details}
          onCloseDetails={(focus) => {
            setDetails(false);
            if (focus) detailsButton.current?.focus();
          }}
        />
      ) : !creating && !empty ? (
        <div className="card scope-content">
          <h2>Choose a {terms.workspace.one}</h2>
          <div className="scope-workspace-list">
            {projects
              .filter((row) => !row.archived)
              .slice(0, 100)
              .map((project) => (
                <button
                  type="button"
                  className="btn"
                  key={text(project.id)}
                  onClick={() => openScope({ type: "project", id: text(project.id) })}
                >
                  <bdi>{text(project.name)}</bdi>
                </button>
              ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

/** The workspace's code folder, or a note that chats get their own app folders. */
function rootLabel(project: Record<string, unknown>) {
  const roots = Array.isArray(project.roots) ? (project.roots as { path?: unknown }[]) : [];
  const paths = roots.map((root) => text(root.path)).filter(Boolean);
  return paths.length
    ? paths.join(" · ")
    : `No code folder: each ${terms.chat.one} gets its own app folder.`;
}
