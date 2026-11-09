import type { QuickContextSource } from "@zoltbot/protocol";
import { useEffect, useRef, useState } from "react";
import { Button, Field, Input, Select } from "../components/primitives.js";
import { errorText, type QuickConnectionProp } from "./data.js";

type Row = Record<string, unknown>;
const mention = /(?:^|\s)@([^\s@]*)$/;
/**
 * Explicit context for Quick Chat: a workspace for bounded read-only search, a workspace or team
 * brief, or chosen files. Picking a source is independent of the inference connection.
 */
export function ContextPicker({
  connection,
  draft,
  setDraft,
  selected,
  destination,
  onAdd,
}: {
  connection: QuickConnectionProp;
  draft: string;
  setDraft(text: string): void;
  selected: QuickContextSource[];
  destination: string | undefined;
  onAdd(source: QuickContextSource): void;
}) {
  const projects = (connection.snapshot.entities.project ?? []).filter((row) => !row.archived);
  const teams = (connection.snapshot.entities.subproject ?? []).filter((row) => !row.archived);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !container.current?.contains(document.activeElement)) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [open]);
  const [projectId, setProjectId] = useState("");
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<{ path: string; label: string }[]>([]);
  const [error, setError] = useState("");
  const project = projects.find((row) => row.id === projectId) as Row | undefined;
  useEffect(() => {
    if (!open || !projectId) return;
    let live = true;
    const timer = setTimeout(() => {
      connection.call("quickChat.files", { projectId, query }).then(
        (result) =>
          live && setFiles((result as { items: { path: string; label: string }[] }).items),
        (failure) => live && setError(errorText(failure)),
      );
    }, 150);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [open, projectId, query, connection.call]);
  const typed = draft.match(mention)?.[1];
  const suggestions =
    typed === undefined
      ? []
      : projects
          .filter((row) => String(row.name).toLowerCase().includes(typed.toLowerCase()))
          .slice(0, 6);
  const addWorkspace = (row: Row) =>
    onAdd({
      id: `workspace:${row.id}`,
      kind: "workspace",
      projectId: String(row.id),
      label: String(row.name),
    });
  return (
    <div className="quick-context" ref={container}>
      {suggestions.length ? (
        <ul className="quick-suggestions" aria-label="Workspaces to search">
          {suggestions.map((row) => (
            <li key={String(row.id)}>
              <button
                type="button"
                onClick={() => {
                  addWorkspace(row);
                  setDraft(draft.replace(mention, (match) => (match.startsWith(" ") ? " " : "")));
                }}
              >
                @{String(row.name)}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <Button
        ref={trigger}
        size="sm"
        variant="ghost"
        icon="Plus"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        Add context
      </Button>
      {open ? (
        <section className="quick-context-panel" aria-label="Add context">
          <p className="quick-muted">
            Context is read on the workspace's host, filtered for secrets, and sent with your next
            message to {destination ?? "the connection you choose"}. Quick Chat can only read: it
            never edits files or runs commands.
          </p>
          {error ? <p role="alert">{error}</p> : null}
          {projects.length ? (
            <>
              <Field label="Workspace">
                <Select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
                  <option value="">Choose…</option>
                  {projects.map((row) => (
                    <option key={String(row.id)} value={String(row.id)}>
                      {String(row.name)}
                    </option>
                  ))}
                </Select>
              </Field>
              {project ? (
                <>
                  <div className="r quick-context-actions">
                    <Button size="sm" type="button" onClick={() => addWorkspace(project)}>
                      Search @{String(project.name)}
                    </Button>
                    <Button
                      size="sm"
                      type="button"
                      onClick={() =>
                        onAdd({
                          id: `brief:project:${project.id}`,
                          kind: "brief",
                          scope: { type: "project", id: String(project.id) },
                          label: String(project.name),
                        })
                      }
                    >
                      Workspace brief
                    </Button>
                    {teams
                      .filter((row) => row.projectId === project.id)
                      .map((row) => (
                        <Button
                          key={String(row.id)}
                          size="sm"
                          type="button"
                          onClick={() =>
                            onAdd({
                              id: `brief:subproject:${row.id}`,
                              kind: "brief",
                              scope: { type: "subproject", id: String(row.id) },
                              label: String(row.name),
                            })
                          }
                        >
                          {String(row.name)} brief
                        </Button>
                      ))}
                  </div>
                  <Field label="Find a file">
                    <Input
                      value={query}
                      placeholder="File name"
                      onChange={(event) => setQuery(event.target.value)}
                    />
                  </Field>
                  <ul className="quick-files" aria-label="Files">
                    {files.map((file) => {
                      const id = `file:${project.id}:${file.path}`;
                      return (
                        <li key={file.path}>
                          <button
                            type="button"
                            disabled={selected.some((row) => row.id === id)}
                            onClick={() =>
                              onAdd({
                                id,
                                kind: "file",
                                projectId: String(project.id),
                                path: file.path,
                                label: file.label,
                              })
                            }
                          >
                            {file.label}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </>
              ) : null}
            </>
          ) : (
            <p className="quick-muted">No workspaces yet.</p>
          )}
        </section>
      ) : null}
    </div>
  );
}
