import { terms } from "@zoltbot/protocol";
import { type ReactNode, useId, useState } from "react";
import { type ChatConnection, type Row, text } from "../chat/types.js";
import { emptyRows, type WorkspaceScope } from "./view.js";

export type Detected = {
  instructions: string[];
  design: { path: string; kind: "guide" | "tokens" }[];
};

/** A path shown relative to the workspace's code folder when it sits inside it. */
export function shortPath(path: string, roots: string[]) {
  const root = roots.find((value) => path.startsWith(`${value.replace(/\/$/, "")}/`));
  return root ? path.slice(root.replace(/\/$/, "").length + 1) : path;
}

export function SideRow({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="ws-row" aria-label={title}>
      <div className="ws-row-main">
        <h3>{title}</h3>
        {children}
      </div>
      {action}
    </section>
  );
}

export function DesignFiles({
  connection,
  project,
  roots,
  detected,
  finding,
  editable,
}: {
  connection: ChatConnection;
  project: Row;
  roots: string[];
  detected: Detected["design"] | undefined;
  finding: boolean;
  editable: boolean;
}) {
  const ids = useId();
  const chosen = Array.isArray(project.designFiles)
    ? (project.designFiles as unknown[]).map(text).filter(Boolean)
    : undefined;
  const files = chosen ?? detected?.map((file) => file.path) ?? [];
  const [editing, setEditing] = useState(false),
    [adding, setAdding] = useState(""),
    [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  const save = async (next: string[] | null) => {
    setSaving(true);
    setError("");
    try {
      await connection.call(
        "project.update",
        { id: text(project.id), changes: { designFiles: next } },
        crypto.randomUUID(),
      );
      return true;
    } catch {
      setError("Could not save the design files. Your list is unchanged.");
      return false;
    } finally {
      setSaving(false);
    }
  };
  const busy = saving || connection.status !== "online";
  return (
    <SideRow
      title="Design"
      action={
        editable ? (
          <button
            type="button"
            className="btn sm ghost"
            aria-expanded={editing}
            aria-controls={`${ids}-edit`}
            onClick={() => setEditing((value) => !value)}
          >
            {editing ? "Done" : "Edit"}
          </button>
        ) : undefined
      }
    >
      {files.length ? (
        <p>
          {chosen ? "Using " : "Found "}
          {files.map((path, index) => (
            <span key={path}>
              {index ? ", " : ""}
              <code title={path}>{shortPath(path, roots)}</code>
            </span>
          ))}
          . Read for design and page work.
        </p>
      ) : finding ? (
        <p>Looking for design files…</p>
      ) : (
        <p>
          {chosen ? "None chosen." : "No DESIGN.md or token files found."} Design and page work uses
          the agent’s own judgement.
        </p>
      )}
      {editing ? (
        <div className="ws-edit" id={`${ids}-edit`}>
          {files.length ? (
            <ul className="ws-files">
              {files.map((path) => (
                <li key={path}>
                  <code title={path}>{shortPath(path, roots)}</code>
                  <button
                    type="button"
                    className="btn sm ghost"
                    disabled={busy}
                    aria-label={`Remove ${shortPath(path, roots)}`}
                    onClick={() => void save(files.filter((value) => value !== path))}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <form
            className="ws-add"
            onSubmit={async (event) => {
              event.preventDefault();
              const value = adding.trim();
              if (!value) return;
              const root = roots[0];
              const path = value.startsWith("/")
                ? value
                : root
                  ? `${root.replace(/\/$/, "")}/${value}`
                  : "";
              if (!path) {
                setError("Enter an absolute path; this workspace has no code folder.");
                return;
              }
              if (files.includes(path)) {
                setAdding("");
                return;
              }
              if (files.length >= 20) {
                setError("Up to 20 design files.");
                return;
              }
              if (await save([...files, path])) setAdding("");
            }}
          >
            <label htmlFor={`${ids}-add`}>Add a file or folder</label>
            <div className="r">
              <input
                id={`${ids}-add`}
                value={adding}
                disabled={busy}
                placeholder="docs/brand.md"
                onChange={(event) => setAdding(event.target.value)}
              />
              <button type="submit" className="btn sm" disabled={busy || !adding.trim()}>
                Add
              </button>
            </div>
          </form>
          {chosen ? (
            <button
              type="button"
              className="btn sm ghost"
              disabled={busy}
              onClick={() => void save(null)}
            >
              Find automatically again
            </button>
          ) : null}
          {error ? <p role="alert">{error}</p> : null}
        </div>
      ) : null}
    </SideRow>
  );
}

/**
 * Goal and instruction text saved in Zolt before AGENTS.md became the one source. Chats still
 * receive it, so it stays visible here until the owner moves it and clears it.
 */
export function SavedText({
  connection,
  scope,
}: {
  connection: ChatConnection;
  scope: WorkspaceScope;
}) {
  const kind = scope.type,
    row = (connection.snapshot.entities[kind] ?? emptyRows).find((entry) => entry.id === scope.id);
  const [confirming, setConfirming] = useState(false),
    [copied, setCopied] = useState(false),
    [error, setError] = useState("");
  if (!row) return null;
  const fields: [string, string][] = (
    [
      ["goal", "Goal"],
      ["instructions", "Instructions"],
      ...(kind === "project" ? [["constraints", "Constraints"] as const] : []),
    ] as const
  )
    .map(([field, label]) => [label, text(row[field]).trim()] as [string, string])
    .filter(([, value]) => value);
  if (!fields.length) return null;
  const combined = fields.map(([label, value]) => `## ${label}\n\n${value}`).join("\n\n");
  return (
    <section className="ws-saved" aria-label="Instructions saved in Zolt">
      <h3>Saved in Zolt from before</h3>
      <p>
        {terms.chat.Many} still get this text. Move it into AGENTS.md, then clear it here so there’s
        one place to edit.
      </p>
      <details>
        <summary>Show text</summary>
        <pre>{combined}</pre>
      </details>
      <div className="r wrap">
        <button
          type="button"
          className="btn sm"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(combined);
              setCopied(true);
            } catch {
              setError("Could not copy. Select the text above instead.");
            }
          }}
        >
          {copied ? "Copied" : "Copy text"}
        </button>
        {confirming ? (
          <>
            <button
              type="button"
              className="btn sm bad"
              disabled={connection.status !== "online"}
              onClick={async () => {
                setError("");
                try {
                  await connection.call(
                    `${kind}.update`,
                    {
                      id: scope.id,
                      changes: {
                        goal: "",
                        instructions: "",
                        ...(kind === "project" ? { constraints: "" } : {}),
                      },
                    },
                    crypto.randomUUID(),
                  );
                } catch {
                  setError("Could not clear it. The text is unchanged.");
                }
                setConfirming(false);
              }}
            >
              Clear for good
            </button>
            <button type="button" className="btn sm ghost" onClick={() => setConfirming(false)}>
              Keep
            </button>
          </>
        ) : (
          <button type="button" className="btn sm ghost" onClick={() => setConfirming(true)}>
            Clear…
          </button>
        )}
      </div>
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
