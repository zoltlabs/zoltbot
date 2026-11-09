import { useEffect, useRef, useState } from "react";
import { type ChatConnection, text } from "../chat/types.js";
import { useShell } from "../state.js";
import { CompareBar, CompareMemberActions } from "./CompareBar.js";
import { CompareColumn } from "./CompareColumn.js";
import { useCompareActions } from "./compare-actions.js";
import { type CompareLayout, layoutFor, scrollFraction, scrollPosition } from "./compare-state.js";
import { useDifferences } from "./Differences.js";
import "../chat/chat.css";
import "./compare.css";
const preference = (key: string, fallback: string) => {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
};
export default function CompareView({
  connection,
  id,
}: {
  connection: ChatConnection;
  id: string;
}) {
  const actions = useCompareActions(connection);
  const e = connection.snapshot.entities;
  const group = e.compare?.find((r) => r.id === id);
  const members = (e.compareMember ?? [])
    .filter((r) => r.compareId === id)
    .sort((a, b) => Number(a.position) - Number(b.position));
  const [preferred, setPreferred] = useState<CompareLayout>("columns"),
    [width, setWidth] = useState(window.innerWidth),
    [active, setActive] = useState(0),
    [sync, setSync] = useState(() => preference("zoltbot.compare.sync", "true") === "true"),
    [error, setError] = useState("");
  const container = useRef<HTMLDivElement>(null),
    syncing = useRef(false);
  useEffect(() => {
    const resize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  useEffect(() => {
    if (!sync) return;
    const root = container.current;
    if (!root) return;
    const listener = (event: Event) => {
      if (
        syncing.current ||
        !(event.target instanceof HTMLElement) ||
        !event.target.classList.contains("chat-timeline")
      )
        return;
      const source = event.target;
      const fraction = scrollFraction(source.scrollTop, source.scrollHeight, source.clientHeight);
      syncing.current = true;
      for (const target of root.querySelectorAll<HTMLElement>(".chat-timeline"))
        if (target !== source)
          target.scrollTop = scrollPosition(fraction, target.scrollHeight, target.clientHeight);
      requestAnimationFrame(() => {
        syncing.current = false;
      });
    };
    root.addEventListener("scroll", listener, true);
    return () => root.removeEventListener("scroll", listener, true);
  }, [sync]);
  const sessionIds = new Set(
    (e.session ?? [])
      .filter(
        (r) =>
          members.some((m) => m.threadId === r.threadId) || r.threadId === group?.summaryThreadId,
      )
      .map((r) => r.id),
  );
  const usage = (e.usage ?? []).filter((r) => sessionIds.has(r.sessionId));
  const cost =
    usage.length && usage.every((r) => r.costKnown === true)
      ? usage.reduce((sum, r) => sum + Number(r.costUsd ?? 0), 0)
      : undefined;
  const layout = layoutFor(width, members.length, preferred);
  const readOnly = group?.state !== "open";
  const differences = useDifferences({
    connection,
    id,
    run: actions.run,
    busy: actions.busy,
    error: actions.error,
    readOnly,
  });
  const onContinue = async (threadId: string) => {
    if (!readOnly && (await actions.run("compare.resolve", { id, action: "continue", threadId })))
      useShell.getState().openThread(threadId);
  };
  const stop = async (threadId: string) => {
    const turn = e.turn?.find((r) => r.threadId === threadId && r.status === "running");
    if (turn && !readOnly)
      await connection.call(
        "turn.interrupt",
        { threadId, turnId: turn.id },
        `compare-stop:${id}:${turn.id}`,
      );
  };
  const stopAll = async () => {
    const results = await Promise.allSettled(members.map((m) => stop(text(m.threadId))));
    if (results.some((r) => r.status === "rejected"))
      setError("Some stops could not be confirmed. Check each column.");
  };
  if (!group || members.length < 2) return <output>Loading compare…</output>;
  const done = members.filter(
    (m) =>
      e.turn?.some(
        (r) =>
          r.threadId === m.threadId &&
          ["completed", "failed", "interrupted"].includes(text(r.status)),
      ) && !e.turn?.some((r) => r.threadId === m.threadId && r.status === "running"),
  ).length;
  const input = Array.isArray(group.input)
    ? (group.input as { type: string; text?: string }[])
    : [];
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: View-scoped shortcuts bubble from accessible controls and scroll regions.
    <div
      className="compare-view"
      ref={container}
      onKeyDown={(event) => {
        if (
          event.altKey &&
          !event.metaKey &&
          !event.ctrlKey &&
          /^[1-4]$/.test(event.key) &&
          !(event.target as HTMLElement).closest(".chat-pending-request")
        ) {
          const member = members[Number(event.key) - 1];
          if (member && !readOnly) {
            event.preventDefault();
            void onContinue(text(member.threadId));
          }
        }
        if ((event.metaKey || event.ctrlKey) && event.key === ".") {
          event.preventDefault();
          void stopAll();
        }
        if (
          (event.metaKey || event.ctrlKey) &&
          event.altKey &&
          ["1", "2", "3"].includes(event.key)
        ) {
          event.preventDefault();
          setPreferred(
            (["columns", "tabs", "stacked"] as const)[Number(event.key) - 1] ?? "columns",
          );
        }
        if (event.ctrlKey && event.key === "Tab") {
          event.preventDefault();
          const next = (active + (event.shiftKey ? members.length - 1 : 1)) % members.length;
          setActive(next);
          requestAnimationFrame(() =>
            container.current
              ?.querySelectorAll<HTMLElement>(".compare-column")
              [next]?.querySelector<HTMLElement>(".chat-timeline")
              ?.focus(),
          );
        }
      }}
    >
      <header className="compare-header">
        <h1>Compare · {members.length}</h1>
        <output>
          {done === members.length
            ? members.length === 2
              ? "Both done"
              : "All done"
            : `${done} of ${members.length} done`}
        </output>
        <span className="sp" />
        {differences.control}
        <fieldset className="compare-layout" aria-label="Compare layout">
          {(["columns", "tabs", "stacked"] as const).map((value) => (
            <button
              className="btn sm"
              type="button"
              key={value}
              aria-pressed={layout === value}
              onClick={() => setPreferred(value)}
            >
              {value[0]?.toUpperCase()}
              {value.slice(1)}
            </button>
          ))}
        </fieldset>
        <label>
          <input
            type="checkbox"
            checked={sync}
            onChange={(event) => {
              setSync(event.target.checked);
              try {
                localStorage.setItem("zoltbot.compare.sync", String(event.target.checked));
              } catch {}
            }}
          />{" "}
          Sync scroll
        </label>
        <button
          className="btn sm"
          type="button"
          disabled={readOnly || done === members.length}
          onClick={() => void stopAll()}
        >
          Stop all
        </button>
      </header>
      <div className="compare-prompt">
        <p>
          {input
            .filter((p) => p.type === "text")
            .map((p) => p.text)
            .join("\n")}
        </p>
        <span>
          Same input · {input.filter((p) => p.type === "file" || p.type === "image").length} files
        </span>
        <small>Knowledge follows each profile’s configured context.</small>
      </div>
      {actions.error ? <p role="alert">{actions.error}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {layout === "tabs" ? (
        <div role="tablist" aria-label="Compare answers">
          {members.map((m, index) => (
            <button
              type="button"
              className="btn"
              role="tab"
              id={`${m.threadId}-tab`}
              aria-controls={`${m.threadId}-panel`}
              aria-selected={active === index}
              tabIndex={active === index ? 0 : -1}
              key={text(m.threadId)}
              onClick={() => setActive(index)}
              onKeyDown={(event) => {
                if (["ArrowLeft", "ArrowRight"].includes(event.key)) {
                  event.preventDefault();
                  const next =
                    (index + (event.key === "ArrowRight" ? 1 : members.length - 1)) %
                    members.length;
                  setActive(next);
                  event.currentTarget.parentElement
                    ?.querySelectorAll<HTMLButtonElement>("button")
                    [next]?.focus();
                }
              }}
            >
              {text(
                e.agent?.find((r) => r.id === e.thread?.find((t) => t.id === m.threadId)?.agentId)
                  ?.name,
              )}
            </button>
          ))}
        </div>
      ) : null}
      {differences.strip}
      {differences.dialog}
      <div className={`compare-columns compare-${layout}`} data-layout={layout}>
        {members.map((m, index) => (
          <CompareColumn
            key={text(m.threadId)}
            connection={connection}
            threadId={text(m.threadId)}
            hidden={layout === "tabs" && active !== index}
            tabbed={layout === "tabs"}
            readOnly={readOnly}
            actions={
              <CompareMemberActions
                primary={index === 0}
                name={text(
                  e.agent?.find((r) => r.id === e.thread?.find((t) => t.id === m.threadId)?.agentId)
                    ?.name,
                )}
                id={id}
                threadId={text(m.threadId)}
                vote={m.vote === "better"}
                run={actions.run}
                disabled={actions.busy || connection.status !== "online"}
                readOnly={readOnly}
                onContinue={onContinue}
              />
            }
            stop={() => {
              void stop(text(m.threadId)).catch(() => setError("Stop could not be confirmed."));
            }}
          />
        ))}
      </div>
      <CompareBar
        connection={connection}
        id={id}
        run={actions.run}
        busy={actions.busy}
        readOnly={readOnly}
        error={actions.error}
      />
      <footer className="compare-status">
        Each column is its own native session <span>Read only: no file edits</span>
        {cost !== undefined ? <span>Reported cost ${cost.toFixed(4)}</span> : null}
      </footer>
    </div>
  );
}
