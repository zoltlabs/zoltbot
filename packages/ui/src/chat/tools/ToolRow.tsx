import { type ReactNode, useContext, useMemo, useState } from "react";
import { Icon } from "../../shell/icons.js";
import { Markdown } from "../Markdown.js";
import { type Row, text } from "../types.js";
import { DiffDialog } from "./DiffDialog.js";
import { DiffCounts } from "./DiffView.js";
import { diffStats, type FileDiff, fileDiffs } from "./diff-data.js";
import { NestedRowsContext } from "./nested.js";
import {
  EditBody,
  ExecuteBody,
  FetchBody,
  GenericBody,
  ReadBody,
  SearchBody,
  ToolImages,
} from "./ToolBodies.js";
import {
  kindIcons,
  kindLabels,
  outputText,
  type ToolKind,
  teamMessageSummary,
  toolKind,
  toolSummary,
} from "./tool-data.js";
import "./tools.css";

const statusLabels: Record<string, string> = {
  running: "Running",
  ok: "Done",
  error: "Failed",
  denied: "Denied",
  recovered: "Fixed on retry",
};
export const statusLabel = (status: string) => statusLabels[status] ?? status;
function StatusMark({ status }: { status: string }) {
  if (status === "running")
    return (
      <span className="tool-status chat-spin" role="img" aria-label="Running">
        <Icon name="Loader" size="sm" />
      </span>
    );
  return (
    <span
      className={`chat-tool-status ${status === "ok" ? "ok" : status === "error" || status === "denied" ? "bad" : "warn"}`}
      aria-hidden="true"
    />
  );
}
function body(kind: ToolKind, value: Row, diffs: FileDiff[]): ReactNode {
  switch (kind) {
    case "execute":
      return <ExecuteBody value={value} />;
    case "edit":
      return <EditBody value={value} diffs={diffs} />;
    case "read":
      return <ReadBody value={value} />;
    case "search":
      return <SearchBody value={value} />;
    case "fetch":
      return <FetchBody value={value} />;
    default:
      return <GenericBody value={value} />;
  }
}
/** Rows reported inside this tool (a subagent or any provider-nested call); none are dropped. */
function NestedSteps({ id, label }: { id: string; label: string }) {
  const { nested, render } = useContext(NestedRowsContext);
  const rows = nested.get(id);
  if (!rows?.length) return null;
  return (
    <ol className="chat-subagent-rows" aria-label={label}>
      {rows.map((row) => (
        <li key={text(row.id)}>{render(row)}</li>
      ))}
    </ol>
  );
}
function useNestedCount(id: string) {
  return useContext(NestedRowsContext).nested.get(id)?.length ?? 0;
}
const failed = (status: string) => status === "error" || status === "denied";
/** Tool card keyed only by the normalized kind (I4). Edits open with their diff inline. */
export function ToolRow({
  id,
  value,
  interaction,
}: {
  id: string;
  value: Row;
  interaction?: Row | undefined;
}) {
  const kind = toolKind(value);
  const nestedCount = useNestedCount(id);
  const rawDiffs = kind === "edit" ? value.diffs : undefined;
  const diffs = useMemo(() => fileDiffs(rawDiffs), [rawDiffs]);
  const stats = useMemo(() => diffStats(diffs), [diffs]);
  const [diffOpen, setDiffOpen] = useState(false);
  if (value.interactive === true)
    return <InteractiveTool id={id} value={value} interaction={interaction} />;
  if (kind === "agent") return <AgentTool id={id} value={value} />;
  // A step the agent fixed on a later try reads as fixed, not failed.
  const status = value.recovered === true ? "recovered" : text(value.status);
  const summary = toolSummary(value);
  const label = teamMessageSummary(value)
    ? "Message"
    : kind === "other"
      ? text(value.name) || kindLabels.other
      : kindLabels[kind];
  return (
    <article
      className={`chat-tool tool-${kind}${failed(status) ? " failed" : ""}`}
      aria-label={`Tool ${text(value.name) || kind}`}
    >
      <details open={diffs.length > 0 || (kind === "execute" && failed(status))}>
        <summary>
          <StatusMark status={status} />
          <span className="tool-kind-icon">
            <Icon name={kindIcons[kind]} size="sm" />
          </span>
          <strong>{label}</strong>
          {/* "Read Read" says nothing twice; the summary shows only when it adds a target. */}
          {summary.toLowerCase() === label.toLowerCase() ? null : (
            <span className="truncate mono" title={summary}>
              {summary}
            </span>
          )}
          {diffs.length ? <DiffCounts {...stats} /> : null}
          {nestedCount ? (
            <span className="chat-tool-state">
              {nestedCount} step{nestedCount === 1 ? "" : "s"}
            </span>
          ) : null}
          {status !== "ok" ? (
            <span className={`chat-tool-state${failed(status) ? " bad" : ""}`}>
              {statusLabel(status)}
            </span>
          ) : null}
        </summary>
        <div className="chat-tool-detail">
          {diffs.length ? (
            <div className="chat-tool-actions">
              <button type="button" className="btn sm" onClick={() => setDiffOpen(true)}>
                Open diff
              </button>
            </div>
          ) : null}
          {body(kind, value, diffs)}
          <ToolImages value={value} />
          <NestedSteps id={id} label="Nested steps" />
        </div>
      </details>
      {diffOpen ? (
        <DiffDialog
          title={diffs.length === 1 ? (diffs[0]?.path ?? "Changes") : `${label}: ${summary}`}
          diffs={diffs}
          onClose={() => setDiffOpen(false)}
        />
      ) : null}
    </article>
  );
}

const requestLabels: Record<string, string> = {
  question: "Asked a question",
  plan: "Proposed a plan",
  approval: "Asked for approval",
  form: "Asked for details",
  gate: "Asked for a review",
};
const stateLabels: Record<string, string> = {
  pending: "Waiting for you",
  answered: "Answered",
  cancelled: "Cancelled",
  expired: "Expired",
};
/** A tool that became an interaction card: one quiet line, the card itself holds the detail. */
export function InteractiveTool({
  id,
  value,
  interaction,
}: {
  id: string;
  value: Row;
  interaction?: Row | undefined;
}) {
  const kind = toolKind(value);
  const label =
    requestLabels[text(interaction?.type)] ??
    (kind === "mode" ? "Proposed a plan" : text(value.title) || "Asked a question");
  const state = interaction
    ? (stateLabels[text(interaction.state)] ?? text(interaction.state))
    : statusLabel(text(value.status));
  return (
    <article className="chat-tool tool-interactive" aria-label={label}>
      <div className="tool-oneline">
        <StatusMark status={text(value.status)} />
        <span className="tool-kind-icon">
          <Icon name={kind === "mode" ? "Todo" : "Inbox"} size="sm" />
        </span>
        <strong>{label}</strong>
        <span className="sp" />
        <span className="chat-tool-state">{state}</span>
      </div>
      <NestedSteps id={id} label="Nested steps" />
    </article>
  );
}

/** A subagent's own tool calls and messages, nested and collapsible under its tool item. */
export function AgentTool({ id, value }: { id: string; value: Row }) {
  const { nested } = useContext(NestedRowsContext);
  const rows = nested.get(id) ?? [];
  const status = text(value.status);
  const summary = toolSummary(value);
  const result = outputText(value.output !== undefined ? value.output : value.content);
  const steps = rows.filter((row) => row.kind === "tool").length;
  return (
    <article className="chat-subagent" aria-label={`Subagent: ${summary}`}>
      <details open={status === "running"}>
        <summary>
          <StatusMark status={status} />
          <span className="tool-kind-icon">
            <Icon name="Bot" size="sm" />
          </span>
          <strong>Subagent:</strong>
          <span className="truncate" title={summary}>
            {summary}
          </span>
          <span className="chat-tool-state">
            {steps ? `${steps} step${steps === 1 ? "" : "s"}` : ""}
            {steps && status !== "ok" ? " · " : ""}
            {status !== "ok" ? statusLabel(status) : ""}
          </span>
        </summary>
        <div className="chat-subagent-body">
          {rows.length ? (
            <NestedSteps id={id} label="Subagent steps" />
          ) : status === "running" ? (
            <p className="tool-empty">Starting…</p>
          ) : null}
          {result.trim() ? (
            <section className="chat-subagent-result" aria-label="Subagent result">
              <div className="sec">Result</div>
              <Markdown value={result} />
            </section>
          ) : null}
        </div>
      </details>
    </article>
  );
}
