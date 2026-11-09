import { type KnowledgeItem, KnowledgeItemSchema, parse, type Scope } from "@zoltbot/protocol";
import { useEffect, useId, useRef, useState } from "react";
import type { ChatConnection } from "../chat/types.js";
import { Button, Chip } from "../components/primitives.js";
import { KnowledgeScopeBar, projectIdOf, userScope, userScopeName } from "./KnowledgeScopeBar.js";
import { kindLabels, kinds, knowledgeLabel, statuses, statusLabels } from "./labels.js";
import "./knowledge.css";

/** The Knowledge view's "Recent agent writes" window. */
const recentAgentWrites = 14 * 24 * 60 * 60 * 1000;
const blank = (scope: Scope): KnowledgeItem => ({
  id: `knowledge-${crypto.randomUUID()}`,
  scope,
  kind: "decision",
  title: "",
  body: "",
  tags: [],
  sources: [],
  owner: { kind: "human", id: "local-owner" },
  verification: "human",
  writer: { kind: "human", id: "local-owner" },
  status: "active",
  revision: 1,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});
export default function Knowledge({
  connection,
  scope: workspaceScope,
}: {
  connection: ChatConnection;
  scope: Scope;
}) {
  const [viewingUser, setViewingUser] = useState(false);
  const scope = viewingUser ? userScope : workspaceScope;
  const id = useId(),
    search = useRef<HTMLInputElement>(null),
    trigger = useRef<HTMLButtonElement | null>(null);
  const [items, setItems] = useState<KnowledgeItem[]>([]),
    [query, setQuery] = useState(""),
    [kind, setKind] = useState(""),
    [status, setStatus] = useState("active"),
    [writer, setWriter] = useState(""),
    [error, setError] = useState(""),
    [draft, setDraft] = useState<KnowledgeItem>();
  const seq = (connection.snapshot.entities.knowledge ?? [])
    .map((row) => `${row.id}:${row.revision}`)
    .join("|");
  const scopeId = scope.id,
    scopeType = scope.type;
  // biome-ignore lint/correctness/useExhaustiveDependencies: committed daemon events invalidate the scoped query.
  useEffect(() => {
    let live = true;
    const projectId = projectIdOf(connection, workspaceScope);
    const request =
      writer === "agent"
        ? connection.call("knowledge.agentWrites", {
            ...(projectId ? { projectId } : {}),
            since: new Date(Date.now() - recentAgentWrites).toISOString(),
            includeUser: true,
          })
        : connection.call("knowledge.list", {
            scope: { type: scopeType, id: scopeId },
            query,
            ...(kind ? { kind } : {}),
            ...(status ? { status } : {}),
            limit: 200,
          });
    request
      .then((value) => {
        if (live) {
          const parsed = (value as { items: unknown[] }).items.map((row) =>
            parse(KnowledgeItemSchema, row),
          );
          const lowered = query.toLowerCase();
          setItems(
            writer === "agent"
              ? parsed.filter(
                  (item) =>
                    (item.scope.type === "user") === viewingUser &&
                    (!kind || item.kind === kind) &&
                    (!lowered || `${item.title} ${item.body}`.toLowerCase().includes(lowered)),
                )
              : parsed,
          );
          setError("");
        }
      })
      .catch(() => {
        if (live)
          setError(
            "Could not load knowledge. Your saved entries are kept. Try again when connected.",
          );
      });
    return () => {
      live = false;
    };
  }, [connection.call, scopeId, scopeType, query, kind, status, writer, viewingUser, seq]);
  const scopeName = (scope: Scope) =>
    scope.type === "user"
      ? userScopeName
      : String(
          [
            ...(connection.snapshot.entities.project ?? []),
            ...(connection.snapshot.entities.subproject ?? []),
          ].find((row) => row.id === scope.id)?.name ?? scope.id,
        );
  const depth = (item: KnowledgeItem) =>
    item.scope.type === "user"
      ? -1
      : item.scope.type === "project"
        ? 0
        : Number(
            connection.snapshot.entities.subproject?.find((row) => row.id === item.scope.id)
              ?.depth ?? 4,
          );
  return (
    <section
      className="knowledge-section"
      aria-label="Knowledge"
      onKeyDown={(event) => {
        if (
          event.key === "/" &&
          !(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)
        ) {
          event.preventDefault();
          search.current?.focus();
        }
      }}
    >
      <header className="r wrap">
        <div className="sp">
          <h2>Knowledge</h2>
          <p className="dim sm">
            {viewingUser
              ? "Your preferences and lessons, shared with every workspace that uses them."
              : "Decisions and constraints shared with new task and chat sessions."}
          </p>
        </div>
        <Button
          onClick={(event) => {
            trigger.current = event.currentTarget;
            setDraft(blank(scope));
          }}
        >
          New knowledge
        </Button>
      </header>
      <KnowledgeScopeBar
        connection={connection}
        scope={workspaceScope}
        viewingUser={viewingUser}
        setViewingUser={setViewingUser}
      />
      <div className="r wrap">
        <label htmlFor={`${id}-search`}>Search knowledge</label>
        <input
          ref={search}
          id={`${id}-search`}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <label htmlFor={`${id}-kind`}>Kind</label>
        <select id={`${id}-kind`} value={kind} onChange={(event) => setKind(event.target.value)}>
          <option value="">All kinds</option>
          {kinds.map((value) => (
            <option key={value} value={value}>
              {kindLabels[value]}
            </option>
          ))}
        </select>
        <label htmlFor={`${id}-status`}>Status</label>
        <select
          id={`${id}-status`}
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        >
          <option value="">All statuses</option>
          {statuses.map((value) => (
            <option key={value} value={value}>
              {statusLabels[value]}
            </option>
          ))}
        </select>
        <label htmlFor={`${id}-writer`}>Written by</label>
        <select
          id={`${id}-writer`}
          value={writer}
          onChange={(event) => setWriter(event.target.value)}
        >
          <option value="">Anyone</option>
          <option value="agent">Recent agent writes</option>
        </select>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      {!items.length && !error ? (
        <p className="dim">No knowledge here yet. Add a decision or constraint for future tasks.</p>
      ) : null}
      <ul
        className="knowledge-list"
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          const buttons = [...event.currentTarget.querySelectorAll("button")];
          const current = buttons.indexOf(event.target as HTMLButtonElement);
          if (current >= 0 && buttons.length) {
            event.preventDefault();
            buttons[
              (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length
            ]?.focus();
          }
        }}
      >
        {items.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              className="knowledge-row"
              onClick={(event) => {
                trigger.current = event.currentTarget;
                setDraft(item);
              }}
            >
              <span>
                <strong>{item.title}</strong>
                <span className="dim sm">
                  {knowledgeLabel(kindLabels, item.kind)} · v{item.revision} ·{" "}
                  {item.scope.id === scope.id ? "Local" : `Inherited from ${scopeName(item.scope)}`}
                </span>
                {item.key
                  ? items
                      .filter((other) => other.id !== item.id && other.key === item.key)
                      .map((other) => (
                        <span className="dim sm" key={other.id}>
                          {depth(item) > depth(other)
                            ? `Overrides ${scopeName(other.scope)}: ${other.title}`
                            : `Overridden in ${scopeName(other.scope)}: ${other.title}`}
                        </span>
                      ))
                  : null}
                {item.pinned && item.reviewBy && item.reviewBy < new Date().toISOString() ? (
                  <span className="dim sm">Review due</span>
                ) : null}
              </span>
              {item.verification === "unverified" ? <Chip>Unverified</Chip> : null}
              <Chip>
                {item.pinned
                  ? "Pinned"
                  : item.reviewBy && item.reviewBy < new Date().toISOString()
                    ? "Review due"
                    : knowledgeLabel(statusLabels, item.status)}
              </Chip>
            </button>
          </li>
        ))}
      </ul>
      {draft ? (
        <KnowledgeEditor
          key={draft.id}
          connection={connection}
          initial={draft}
          exists={items.some((row) => row.id === draft.id)}
          close={() => {
            setDraft(undefined);
            trigger.current?.focus();
          }}
        />
      ) : null}
    </section>
  );
}
export function KnowledgeEditor({
  connection,
  initial,
  exists,
  close,
}: {
  connection: ChatConnection;
  initial: KnowledgeItem;
  exists: boolean;
  close(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    titleInput = useRef<HTMLInputElement>(null),
    id = useId();
  const [draft, setDraft] = useState(initial),
    [expected, setExpected] = useState(exists ? initial.revision : 0),
    [error, setError] = useState(""),
    [conflict, setConflict] = useState<KnowledgeItem>(),
    [history, setHistory] = useState<KnowledgeItem[]>([]),
    [pending, setPending] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
    titleInput.current?.focus();
  }, []);
  const [confirmClose, setConfirmClose] = useState(false);
  const [tagsText, setTagsText] = useState(initial.tags.join(", "));
  const requestClose = () => {
    if (JSON.stringify(draft) !== JSON.stringify(initial)) setConfirmClose(true);
    else close();
  };
  const save = async (archive = false) => {
    if (!draft.title.trim() || !draft.body.trim()) {
      setError("Enter a title and body. Your draft is kept.");
      titleInput.current?.focus();
      return;
    }
    if (pending || conflict) return;
    setPending(true);
    setError("");
    try {
      await connection.call(
        "knowledge.upsert",
        {
          value: { ...draft, ...(archive ? { status: "archived" } : {}) },
          expectedRevision: expected,
        },
        crypto.randomUUID(),
      );
      close();
    } catch (problem) {
      if (problem instanceof Error && problem.message.includes("knowledge_revision_conflict")) {
        setConflict(
          parse(KnowledgeItemSchema, await connection.call("knowledge.get", { id: draft.id })),
        );
        setError(
          "This entry changed. Your draft is kept. Compare with the current version before saving.",
        );
      } else if (problem instanceof Error && problem.message.includes("knowledge_duplicate_key"))
        setError(
          "This override key is already used in this scope. Choose another key. Your draft is kept.",
        );
      else setError("Could not save. Your draft is kept. Try again when connected.");
    } finally {
      setPending(false);
    }
  };
  return (
    <dialog
      ref={dialog}
      className="knowledge-editor zb-card"
      aria-labelledby={`${id}-heading`}
      onCancel={(event) => {
        event.preventDefault();
        requestClose();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <h2 id={`${id}-heading`}>{exists ? "Edit knowledge" : "New knowledge"}</h2>
        <label htmlFor={`${id}-title`}>Knowledge title</label>
        <input
          ref={titleInput}
          id={`${id}-title`}
          maxLength={200}
          required
          value={draft.title}
          onChange={(event) => setDraft({ ...draft, title: event.target.value })}
        />
        <label htmlFor={`${id}-kind`}>Knowledge kind</label>
        <select
          id={`${id}-kind`}
          value={draft.kind}
          onChange={(event) =>
            setDraft({ ...draft, kind: event.target.value as KnowledgeItem["kind"] })
          }
        >
          {kinds.map((value) => (
            <option key={value} value={value}>
              {kindLabels[value]}
            </option>
          ))}
        </select>
        <label htmlFor={`${id}-body`}>Knowledge body</label>
        <textarea
          id={`${id}-body`}
          maxLength={1200}
          rows={7}
          required
          value={draft.body}
          onChange={(event) => setDraft({ ...draft, body: event.target.value })}
        />
        <label className="r">
          <input
            type="checkbox"
            checked={draft.pinned ?? false}
            onChange={(event) => setDraft({ ...draft, pinned: event.target.checked })}
          />
          Pin for future tasks
        </label>
        <details>
          <summary>More details</summary>
          <label htmlFor={`${id}-key`}>Override key</label>
          <input
            id={`${id}-key`}
            value={draft.key ?? ""}
            onChange={(event) => setDraft({ ...draft, key: event.target.value })}
          />
          <label htmlFor={`${id}-tags`}>Tags (comma separated)</label>
          <input
            id={`${id}-tags`}
            value={tagsText}
            onChange={(event) => {
              setTagsText(event.target.value);
              setDraft({
                ...draft,
                tags: event.target.value
                  .split(",")
                  .map((tag) => tag.trim())
                  .filter(Boolean),
              });
            }}
          />
          <label htmlFor={`${id}-review`}>Review by</label>
          <input
            id={`${id}-review`}
            type="date"
            value={draft.reviewBy?.slice(0, 10) ?? ""}
            onChange={(event) => {
              const { reviewBy: _old, ...rest } = draft;
              setDraft({
                ...rest,
                ...(event.target.value ? { reviewBy: `${event.target.value}T23:59:59.000Z` } : {}),
              });
            }}
          />
          <label htmlFor={`${id}-source`}>Source URL (optional)</label>
          <input
            id={`${id}-source`}
            type="url"
            value={draft.sources.find((source) => source.kind === "url")?.ref ?? ""}
            onChange={(event) =>
              setDraft({
                ...draft,
                sources: [
                  ...draft.sources.filter((source) => source.kind !== "url"),
                  ...(event.target.value
                    ? [{ kind: "url" as const, ref: event.target.value }]
                    : []),
                ],
              })
            }
          />
          {draft.sources.map((source) => (
            <p key={`${source.kind}:${source.ref}`}>
              {source.kind}: {source.label ?? source.ref}
            </p>
          ))}
        </details>
        {exists ? (
          <details
            onToggle={async (event) => {
              if (event.currentTarget.open) {
                try {
                  setHistory(
                    (
                      (await connection.call("knowledge.revisions", { id: draft.id })) as unknown[]
                    ).map((row) => parse(KnowledgeItemSchema, row)),
                  );
                } catch {
                  setError("Could not load history. Your draft is kept.");
                }
              }
            }}
          >
            <summary>History</summary>
            {history.map((row) => (
              <article key={row.revision}>
                <h3>
                  v{row.revision} · {row.title}
                </h3>
                <p>{row.body}</p>
                {row.sources.map((source) => (
                  <p className="dim sm" key={`${source.kind}:${source.ref}`}>
                    {source.kind}: {source.label ?? source.ref}
                    {source.taskRevision ? ` · task revision ${source.taskRevision}` : ""}
                    {source.sourceReviewState ? ` · ${source.sourceReviewState}` : ""}
                  </p>
                ))}
              </article>
            ))}
          </details>
        ) : null}
        {conflict ? (
          <section aria-label="Current version">
            <h3>Current version v{conflict.revision}</h3>
            <p>{conflict.body}</p>
            <Button
              onClick={() => {
                setExpected(conflict.revision);
                setConflict(undefined);
                setError("Compared. Saving creates the next version with your draft.");
              }}
            >
              Keep my draft for next version
            </Button>
          </section>
        ) : null}
        {error ? <p role="alert">{error}</p> : null}
        {pending || conflict ? (
          <p id={`${id}-save-reason`} aria-live="polite">
            {pending ? "Saving your draft…" : "Compare with the latest version before saving."}
          </p>
        ) : null}
        {confirmClose ? (
          <section aria-label="Unsaved knowledge draft">
            <p>Your draft has unsaved changes.</p>
            <Button onClick={() => setConfirmClose(false)}>Keep editing</Button>
            <Button onClick={close}>Discard draft</Button>
          </section>
        ) : null}
        <div className="r wrap">
          <Button
            type="submit"
            variant="primary"
            aria-disabled={pending || !!conflict}
            aria-describedby={pending || conflict ? `${id}-save-reason` : undefined}
            onClick={(event) => {
              if (pending || conflict) event.preventDefault();
            }}
          >
            Save knowledge
          </Button>
          <Button onClick={requestClose}>Cancel</Button>
          {exists ? <Button onClick={() => void save(true)}>Archive</Button> : null}
        </div>
      </form>
    </dialog>
  );
}
