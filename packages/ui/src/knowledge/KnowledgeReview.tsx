import {
  type KnowledgeItem,
  KnowledgeItemSchema,
  type KnowledgeProposal,
  KnowledgeProposalSchema,
  parse,
  type Scope,
} from "@zoltbot/protocol";
import { useEffect, useId, useState } from "react";
import type { ChatConnection } from "../chat/types.js";
import { Button, Chip } from "../components/primitives.js";
import { KnowledgeEditor } from "./Knowledge.js";
import { userScope, userScopeName } from "./KnowledgeScopeBar.js";
import { kindLabels, knowledgeLabel } from "./labels.js";

const day = 24 * 60 * 60 * 1000;
const why: Record<string, string> = {
  user_scope: "Writes to your personal knowledge always need you.",
  protected_item: "It changes or conflicts with something a person wrote.",
  tainted: "The session read outside content, so it cannot change shared knowledge alone.",
  grant_required: "The agent has no grant to write this kind here.",
};
const errors: Record<string, string> = {
  knowledge_revision_conflict:
    "The item changed since this was proposed. Reject it or edit the item.",
  proposal_already_decided: "Someone already decided this proposal.",
  knowledge_revision: "The item changed. Reload and try again.",
};
const message = (error: unknown, fallback: string) =>
  errors[String((error as Error)?.message ?? "").split(":")[0] ?? ""] ?? fallback;

/** Change counter so lists refetch when committed knowledge or proposals change. */
function useKnowledgeSeq(connection: ChatConnection) {
  return [
    ...(connection.snapshot.entities.knowledge ?? []),
    ...(connection.snapshot.entities.knowledgeProposal ?? []),
  ]
    .map((row) => `${row.id}:${row.revision ?? ""}:${row.state ?? ""}`)
    .join("|");
}

function scopeLabel(connection: ChatConnection, scope: Scope) {
  if (scope.type === "user") return userScopeName;
  const row = [
    ...(connection.snapshot.entities.project ?? []),
    ...(connection.snapshot.entities.subproject ?? []),
    ...(connection.snapshot.entities.task ?? []),
  ].find((entry) => entry.id === scope.id);
  return `${scope.type} ${String(row?.name ?? row?.title ?? scope.id)}`;
}

function Proposal({
  connection,
  proposal,
}: {
  connection: ChatConnection;
  proposal: KnowledgeProposal;
}) {
  const id = useId();
  const [mode, setMode] = useState<"view" | "edit" | "reject">("view");
  const [title, setTitle] = useState(proposal.title),
    [body, setBody] = useState(proposal.body),
    [scope, setScope] = useState(JSON.stringify(proposal.scope)),
    [reason, setReason] = useState(""),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const scopes: Scope[] = [
    proposal.scope,
    ...(proposal.scope.type === "user" ? [] : [userScope]),
    ...(connection.snapshot.entities.project ?? [])
      .filter((row) => !row.archived && row.id !== proposal.scope.id)
      .map((row) => ({ type: "project" as const, id: String(row.id) })),
  ];
  const decide = async (params: Record<string, unknown>) => {
    setPending(true);
    setError("");
    try {
      await connection.call("proposal.decide", { id: proposal.id, ...params }, crypto.randomUUID());
    } catch (cause) {
      setError(message(cause, "Could not save this decision. The proposal is kept."));
    } finally {
      setPending(false);
    }
  };
  const disabled = pending || connection.status !== "online";
  return (
    <li className="knowledge-review-row">
      <div className="r wrap">
        <strong>{proposal.title}</strong>
        <Chip>
          {proposal.op === "create"
            ? knowledgeLabel(kindLabels, proposal.kind)
            : `${proposal.op.charAt(0).toUpperCase()}${proposal.op.slice(1)} ${knowledgeLabel(kindLabels, proposal.kind).toLowerCase()}`}
        </Chip>
        <Chip tone="attention">{scopeLabel(connection, proposal.scope)}</Chip>
      </div>
      <p className="sm">{proposal.body}</p>
      <p className="dim sm">
        {why[proposal.why] ?? proposal.why.replaceAll("_", " ")} Agent reason: {proposal.reason}
      </p>
      {proposal.conflicts.length ? (
        <p className="dim sm">Conflicts with {proposal.conflicts.length} existing item(s).</p>
      ) : null}
      {mode === "edit" ? (
        <div className="knowledge-review-edit">
          <label htmlFor={`${id}-title`}>Title</label>
          <input
            id={`${id}-title`}
            value={title}
            maxLength={200}
            onChange={(event) => setTitle(event.target.value)}
          />
          <label htmlFor={`${id}-body`}>Body</label>
          <textarea
            id={`${id}-body`}
            value={body}
            maxLength={1200}
            onChange={(event) => setBody(event.target.value)}
          />
          {proposal.op === "create" ? (
            <>
              <label htmlFor={`${id}-scope`}>Scope</label>
              <select
                id={`${id}-scope`}
                value={scope}
                onChange={(event) => setScope(event.target.value)}
              >
                {scopes.map((option) => (
                  <option key={JSON.stringify(option)} value={JSON.stringify(option)}>
                    {scopeLabel(connection, option)}
                  </option>
                ))}
              </select>
            </>
          ) : null}
        </div>
      ) : null}
      {mode === "reject" ? (
        <div className="knowledge-review-edit">
          <label htmlFor={`${id}-reason`}>
            Why reject? Agents that propose the same thing again are rejected automatically.
          </label>
          <input
            id={`${id}-reason`}
            value={reason}
            maxLength={300}
            onChange={(event) => setReason(event.target.value)}
          />
        </div>
      ) : null}
      <div className="r wrap">
        {mode === "reject" ? (
          <>
            <Button
              variant="danger"
              size="sm"
              disabled={disabled || !reason.trim()}
              onClick={() => decide({ decision: "reject", reason: reason.trim() })}
            >
              Reject proposal
            </Button>
            <Button size="sm" onClick={() => setMode("view")}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="primary"
              size="sm"
              disabled={disabled || !title.trim() || !body.trim()}
              onClick={() =>
                decide({
                  decision: "accept",
                  ...(title !== proposal.title ? { title } : {}),
                  ...(body !== proposal.body ? { body } : {}),
                  ...(scope !== JSON.stringify(proposal.scope) ? { scope: JSON.parse(scope) } : {}),
                })
              }
            >
              {mode === "edit" ? "Accept edited" : "Accept"}
            </Button>
            {mode === "view" ? (
              <Button size="sm" onClick={() => setMode("edit")}>
                Edit or rescope
              </Button>
            ) : (
              <Button size="sm" onClick={() => setMode("view")}>
                Cancel edit
              </Button>
            )}
            <Button size="sm" onClick={() => setMode("reject")}>
              Reject…
            </Button>
          </>
        )}
      </div>
      {error ? <p role="alert">{error}</p> : null}
    </li>
  );
}

/** One agent-written item with confirm, edit and revert (revert is a new human revision or archive). */
export function AgentWrite({
  connection,
  item,
  edit,
}: {
  connection: ChatConnection;
  item: KnowledgeItem;
  edit(item: KnowledgeItem): void;
}) {
  const [confirmRevert, setConfirmRevert] = useState(false),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const act = async (method: string, params: Record<string, unknown>, fallback: string) => {
    setPending(true);
    setError("");
    try {
      await connection.call(
        method,
        { id: item.id, expectedRevision: item.revision, ...params },
        crypto.randomUUID(),
      );
      setConfirmRevert(false);
    } catch (cause) {
      setError(message(cause, fallback));
    } finally {
      setPending(false);
    }
  };
  const disabled = pending || connection.status !== "online";
  return (
    <li className="knowledge-review-row">
      <div className="r wrap">
        <strong>{item.title}</strong>
        <Chip>{knowledgeLabel(kindLabels, item.kind)}</Chip>
        <Chip>{scopeLabel(connection, item.scope)}</Chip>
        {item.verification === "unverified" ? <Chip tone="attention">Unverified</Chip> : null}
        <span className="dim sm">v{item.revision}</span>
      </div>
      <p className="sm">{item.body}</p>
      <div className="r wrap">
        {item.verification === "unverified" ? (
          <Button
            size="sm"
            disabled={disabled}
            onClick={() => act("knowledge.confirm", {}, "Could not confirm. The item is kept.")}
          >
            Confirm
          </Button>
        ) : null}
        <Button size="sm" disabled={disabled} onClick={() => edit(item)}>
          Edit
        </Button>
        {confirmRevert ? (
          <>
            <span className="sm">
              {item.revision > 1
                ? "Restore the previous revision as your own?"
                : "Archive this item? It stays in history."}
            </span>
            <Button
              variant="danger"
              size="sm"
              disabled={disabled}
              onClick={() =>
                act("knowledge.revert", { confirmed: true }, "Could not revert. The item is kept.")
              }
            >
              {item.revision > 1 ? "Restore previous" : "Archive"}
            </Button>
            <Button size="sm" onClick={() => setConfirmRevert(false)}>
              Keep
            </Button>
          </>
        ) : (
          <Button size="sm" disabled={disabled} onClick={() => setConfirmRevert(true)}>
            Revert…
          </Button>
        )}
      </div>
      {error ? <p role="alert">{error}</p> : null}
    </li>
  );
}

/** Inbox sections: pending knowledge proposals and the daily digest of agent writes. */
export function KnowledgeInbox({ connection }: { connection: ChatConnection }) {
  const [proposals, setProposals] = useState<KnowledgeProposal[]>([]),
    [writes, setWrites] = useState<KnowledgeItem[]>([]),
    [editing, setEditing] = useState<KnowledgeItem>(),
    [error, setError] = useState("");
  const seq = useKnowledgeSeq(connection);
  // biome-ignore lint/correctness/useExhaustiveDependencies: committed daemon events invalidate the lists.
  useEffect(() => {
    if (connection.status !== "online") return;
    let live = true;
    Promise.all([
      connection.call("proposal.list", { state: "pending" }),
      connection.call("knowledge.agentWrites", {
        since: new Date(Date.now() - day).toISOString(),
      }),
    ])
      .then(([listed, written]) => {
        if (!live) return;
        setProposals(
          (listed as { items: unknown[] }).items.map((row) => parse(KnowledgeProposalSchema, row)),
        );
        setWrites(
          (written as { items: unknown[] }).items.map((row) => parse(KnowledgeItemSchema, row)),
        );
        setError("");
      })
      .catch(() => live && setError("Could not load knowledge for review."));
    return () => {
      live = false;
    };
  }, [connection.call, connection.status, seq]);
  if (!proposals.length && !writes.length && !error) return null;
  return (
    <>
      {error ? <p role="alert">{error}</p> : null}
      {proposals.length ? (
        <section className="knowledge-review" aria-label="Knowledge proposals">
          <h2>
            Knowledge proposals <Chip tone="attention">{proposals.length}</Chip>
          </h2>
          <ul>
            {proposals.map((proposal) => (
              <Proposal key={proposal.id} connection={connection} proposal={proposal} />
            ))}
          </ul>
        </section>
      ) : null}
      {writes.length ? (
        <section className="knowledge-review" aria-label="Agent knowledge writes today">
          <h2>
            Agent writes today <Chip>{writes.length}</Chip>
          </h2>
          <p className="dim sm">Applied by agents in the last 24 hours. Confirm, edit or revert.</p>
          <ul>
            {writes.map((item) => (
              <AgentWrite key={item.id} connection={connection} item={item} edit={setEditing} />
            ))}
          </ul>
        </section>
      ) : null}
      {editing ? (
        <KnowledgeEditor
          key={editing.id}
          connection={connection}
          initial={editing}
          exists
          close={() => setEditing(undefined)}
        />
      ) : null}
    </>
  );
}
