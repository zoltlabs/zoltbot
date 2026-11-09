import type { ShippingFeedback, ShippingSnapshot } from "@zoltbot/protocol";
import { useId, useState } from "react";
import { Button } from "../components/primitives.js";
import { failureStates, safeLink } from "./view.js";

export function ExternalLink({ url, children }: { url: string; children: React.ReactNode }) {
  const safe = safeLink(url);
  return safe ? (
    <a href={safe} target="_blank" rel="noreferrer">
      {children} ↗
    </a>
  ) : null;
}
export function ShippingDetails({
  snapshot,
  selected,
  setSelected,
  diagnostics,
  fetchDiagnostics,
  batches,
}: {
  snapshot: ShippingSnapshot;
  selected: string[];
  setSelected(values: string[]): void;
  diagnostics: Record<string, string>;
  fetchDiagnostics(id: string): void;
  batches: ShippingFeedback[];
}) {
  const id = useId(),
    [filter, setFilter] = useState("unresolved");
  const toggle = (key: string) =>
    setSelected(selected.includes(key) ? selected.filter((s) => s !== key) : [...selected, key]);
  const checks = [...snapshot.checks].sort(
    (a, b) => Number(failureStates.has(b.state)) - Number(failureStates.has(a.state)),
  );
  const threads = snapshot.threads.filter(
    (t) =>
      filter === "all" ||
      (filter === "resolved" ? t.resolved : filter === "outdated" ? t.outdated : !t.resolved),
  );
  return (
    <>
      <section aria-labelledby={`${id}-checks`}>
        <h3 id={`${id}-checks`}>Checks for {snapshot.head.slice(0, 7)}</h3>
        <p className="dim sm">
          Requirements {snapshot.requirementsKnown ? "reported by GitHub" : "unavailable"}. Check
          results alone do not establish permission to merge.
        </p>
        {!checks.length ? (
          <p>No checks reported for this head.</p>
        ) : (
          checks.map((check) => (
            <article className="shipping-check" key={check.id}>
              <label>
                <input
                  type="checkbox"
                  checked={selected.includes(`check:${check.id}`)}
                  onChange={() => toggle(`check:${check.id}`)}
                />{" "}
                <bdi>{check.name}</bdi> · {check.state.toLowerCase().replaceAll("_", " ")}
                {check.required ? " · Required" : ""}
              </label>
              <p className="dim sm">
                Commit {check.sha.slice(0, 7)}
                {check.sha !== snapshot.head ? " · Different execution commit" : ""}
              </p>
              <div className="r wrap">
                <Button size="sm" onClick={() => fetchDiagnostics(check.id)}>
                  Show diagnostics
                </Button>
                <ExternalLink url={check.url}>Open check</ExternalLink>
              </div>
              {diagnostics[check.id] ? <pre>{diagnostics[check.id]}</pre> : null}
            </article>
          ))
        )}
      </section>
      <section aria-labelledby={`${id}-threads`}>
        <h3 id={`${id}-threads`}>Review and conversation</h3>
        <label htmlFor={`${id}-filter`}>Show feedback</label>{" "}
        <select id={`${id}-filter`} value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="unresolved">
            Unresolved ({snapshot.threads.filter((t) => !t.resolved).length})
          </option>
          <option value="outdated">
            Outdated ({snapshot.threads.filter((t) => t.outdated).length})
          </option>
          <option value="resolved">
            Resolved ({snapshot.threads.filter((t) => t.resolved).length})
          </option>
          <option value="all">All ({snapshot.threads.length})</option>
        </select>
        <Button
          size="sm"
          onClick={() =>
            setSelected(
              [
                ...new Set([
                  ...selected,
                  ...snapshot.threads.filter((t) => !t.resolved).map((t) => t.id),
                ]),
              ].slice(0, 20),
            )
          }
        >
          Select unresolved feedback
        </Button>
        {!threads.length ? (
          <p>No feedback in this view.</p>
        ) : (
          threads.map((thread) => (
            <article className="shipping-thread" key={thread.id}>
              <label>
                <input
                  type="checkbox"
                  checked={selected.includes(thread.id)}
                  onChange={() => toggle(thread.id)}
                  aria-label={`Select feedback from ${thread.author} at ${thread.path || thread.kind}${thread.line ? ` line ${thread.line}` : ""}`}
                />{" "}
                <bdi>
                  {thread.path || thread.kind}
                  {thread.line ? `:${thread.line}` : ""}
                </bdi>{" "}
                · <bdi>@{thread.author}</bdi>
              </label>
              <p className="dim sm">
                {thread.outdated ? "Outdated — code changed since this comment. " : ""}
                {thread.resolved ? "Resolved on GitHub." : "Unresolved on GitHub."}
              </p>
              {thread.diff ? (
                <details>
                  <summary>Comment diff context</summary>
                  <pre>{thread.diff}</pre>
                </details>
              ) : null}
              <pre>{thread.body}</pre>
              <ExternalLink url={thread.url}>Open discussion</ExternalLink>
              {batches.some(
                (b) => b.state === "delivered" && b.sources.some((s) => s.id === thread.id),
              ) ? (
                <p className="dim sm">
                  Previously sent to agent. Sending again requires a new preview.
                </p>
              ) : null}
            </article>
          ))
        )}
      </section>
      {!snapshot.complete ? (
        <output>
          Some checks or discussion pages exceed the display limit. This is a partial view; open
          GitHub for the full discussion.
        </output>
      ) : null}
    </>
  );
}
