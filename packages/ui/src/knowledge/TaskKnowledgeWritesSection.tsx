import { scopeNoun, terms } from "@zoltbot/protocol";
import { useEffect, useState } from "react";
import { type ContextSectionProps, registerContextSection } from "../context/SessionInputsPanel.js";
import { kindLabels, knowledgeLabel } from "./labels.js";

interface Write {
  id: string;
  op: string;
  outcome: string;
  reason: string;
  source: string;
  title?: string;
  kind?: string;
  itemId?: string;
  proposalId?: string;
  revision?: number;
  scope?: { type: string; id: string };
  at: string;
}
interface Taint {
  sessionId: string;
  cause: string;
  label?: string;
  at: string;
}
const causes: Record<string, string> = {
  fetch: "fetched web content",
  browser: "read a browser page",
  connected_app: "used a connected app",
  outside_workspace: "read a file outside the workspace",
  attachment: "received a non-text attachment",
  cross_project_message: `received a message from another ${terms.workspace.one}`,
  unknown: "used a tool Zoltbot cannot classify",
};

/** "workspace", "team" or "you" for a write's scope, instead of the stored type. */
function scopeLabel(type: string) {
  if (type === "project" || type === "subproject") return scopeNoun(type).one;
  return type === "user" ? "you" : type;
}

/** Inspector section 8: what this run wrote to knowledge, and whether its writes are held for review. */
export function TaskKnowledgeWritesSection({ connection, task, mode }: ContextSectionProps) {
  const [writes, setWrites] = useState<Write[]>([]);
  const [taint, setTaint] = useState<Taint[]>([]);
  const [error, setError] = useState("");
  const id = String(task.id);
  const seq = [
    ...(connection.snapshot.entities.knowledge ?? []),
    ...(connection.snapshot.entities.knowledgeProposal ?? []),
  ]
    .map((row) => `${row.id}:${row.revision ?? row.updatedAt}`)
    .join("|");
  // biome-ignore lint/correctness/useExhaustiveDependencies: committed knowledge events invalidate the list.
  useEffect(() => {
    if (mode === "preview") return;
    let live = true;
    connection
      .call("knowledge.writes", { taskId: id })
      .then((value) => {
        const result = value as { writes: Write[]; taint: Taint[] };
        if (!live) return;
        setWrites(result.writes);
        setTaint(result.taint);
        setError("");
      })
      .catch(() => live && setError("Could not load knowledge writes for this run."));
    return () => {
      live = false;
    };
  }, [connection.call, id, mode, seq]);
  if (mode === "preview")
    return <p className="dim sm">Agent writes appear after the run starts.</p>;
  return (
    <div>
      {error ? <output>{error}</output> : null}
      {taint.length ? (
        taint.map((row) => (
          <p key={row.sessionId} className="sm">
            <output>
              Tainted: this session {causes[row.cause] ?? row.cause}
              {row.label ? ` (${row.label})` : ""}. Writes above its own node go to review.
            </output>
          </p>
        ))
      ) : (
        <p className="dim sm">Not tainted.</p>
      )}
      {!writes.length ? <p className="dim sm">No knowledge written by this run.</p> : null}
      <ul>
        {writes.map((row) => (
          <li key={row.id}>
            <strong>{row.outcome}</strong> · {row.op}
            {row.kind ? ` ${knowledgeLabel(kindLabels, row.kind).toLowerCase()}` : ""}
            {row.title ? ` “${row.title}”` : ""}
            {row.scope ? ` · ${scopeLabel(row.scope.type)}` : ""}
            {row.revision ? ` · v${row.revision}` : ""} ·{" "}
            <span className="dim">{row.reason.replaceAll("_", " ")}</span>
            {row.source === "learned" ? <span className="dim"> · learned</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
registerContextSection({
  id: "8-knowledge-written",
  title: "Knowledge written",
  render: (props) => <TaskKnowledgeWritesSection {...props} />,
});
