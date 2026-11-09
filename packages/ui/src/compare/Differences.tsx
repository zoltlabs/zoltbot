import { differencesPrompt } from "@zoltbot/protocol";
import { useEffect, useState } from "react";
import { Markdown } from "../chat/Markdown.js";
import { body, type ChatConnection, text } from "../chat/types.js";
import { Dialog } from "../components/primitives.js";
import { useShell } from "../state.js";
import type { CompareRun } from "./compare-actions.js";
import { compareAnswers } from "./compare-state.js";

function storedHidden(id: string) {
  try {
    return localStorage.getItem(`zoltbot.compare.differences.${id}`) === "hidden";
  } catch {
    return false;
  }
}
/** One controller renders the header action, above-column strip and review dialog in their slots. */
export function useDifferences({
  connection,
  id,
  run,
  busy,
  error,
  readOnly,
}: {
  connection: ChatConnection;
  id: string;
  run: CompareRun;
  busy: boolean;
  error: string;
  readOnly: boolean;
}) {
  const e = connection.snapshot.entities,
    group = e.compare?.find((r) => r.id === id),
    summaryId = text(group?.summaryThreadId),
    answers = compareAnswers(e, id),
    members = (e.compareMember ?? []).filter((r) => r.compareId === id);
  const [hidden, setHidden] = useState(() => storedHidden(id)),
    [preview, setPreview] = useState<{ prompt: string; profileId: string } | undefined>();
  useEffect(() => {
    setHidden(storedHidden(id));
  }, [id]);
  useEffect(() => {
    if (summaryId) setPreview(undefined);
  }, [summaryId]);
  const hide = (value: boolean) => {
    setHidden(value);
    try {
      localStorage.setItem(`zoltbot.compare.differences.${id}`, value ? "hidden" : "shown");
    } catch {}
  };
  const ready =
    members.length >= 2 &&
    members.every((m) =>
      e.turn?.some(
        (r) =>
          r.threadId === m.threadId &&
          ["completed", "failed", "interrupted"].includes(text(r.status)),
      ),
    ) &&
    !e.turn?.some(
      (r) => members.some((m) => m.threadId === r.threadId) && r.status === "running",
    ) &&
    !e.interaction?.some(
      (r) => members.some((m) => m.threadId === r.threadId) && r.state === "pending",
    );
  const preferred =
    text(members.find((r) => r.vote === "better")?.threadId) || answers[0]?.threadId;
  const writer = answers.find((a) => a.threadId === preferred)?.profileId ?? "";
  const thread = e.thread?.find((r) => r.id === summaryId),
    profile = e.agent?.find((r) => r.id === thread?.agentId),
    sessions = new Set(e.session?.filter((r) => r.threadId === summaryId).map((r) => r.id));
  const usage = (e.usage ?? []).filter((r) => sessions.has(r.sessionId)),
    cost =
      usage.length && usage.every((r) => r.costKnown === true)
        ? usage.reduce((sum, r) => sum + Number(r.costUsd ?? 0), 0)
        : undefined;
  const message = (e.item ?? [])
      .filter((r) => r.threadId === summaryId && r.kind === "message" && !body(r).parentItemId)
      .sort((a, b) => Number(a.seq) - Number(b.seq))
      .at(-1),
    answer = text(message && body(message).text);
  const turn = e.turn?.find((r) => r.threadId === summaryId && r.status === "running"),
    failed = e.turn?.some((r) => r.threadId === summaryId && r.status === "failed");
  const disabled = busy || connection.status !== "online";
  return {
    control: (
      <button
        className="btn sm"
        type="button"
        disabled={summaryId ? false : disabled || readOnly || !ready}
        onClick={() => {
          if (summaryId) {
            hide(false);
            requestAnimationFrame(() => document.getElementById(`differences-${id}`)?.focus());
          } else setPreview({ prompt: differencesPrompt(answers), profileId: writer });
        }}
      >
        {summaryId && hidden ? "Show differences" : "Where they differ"}
      </button>
    ),
    strip:
      summaryId && !hidden ? (
        <section
          className="compare-differences"
          id={`differences-${id}`}
          tabIndex={-1}
          aria-label="Where they differ"
        >
          <header className="r wrap">
            <strong>Where they differ</strong>
            <span>Summary by {text(profile?.name) || "the selected profile"}</span>
            <span>
              {cost === undefined ? "Cost not reported yet" : `Reported $${cost.toFixed(4)}`}
            </span>
            <span className="sp" />
            <button
              className="btn sm"
              type="button"
              onClick={() => useShell.getState().openThread(summaryId)}
            >
              Open summary chat
            </button>
            {turn ? (
              <button
                className="btn sm"
                type="button"
                disabled={disabled || readOnly}
                onClick={() => {
                  void run("turn.interrupt", { threadId: summaryId, turnId: turn.id });
                }}
              >
                Stop differences
              </button>
            ) : null}
            <button className="btn sm" type="button" onClick={() => hide(true)}>
              Hide differences
            </button>
          </header>
          {answer ? (
            <Markdown value={answer} />
          ) : (
            <output>
              {failed
                ? "The summary could not complete. Open its chat to review details."
                : "Writing differences…"}
            </output>
          )}
        </section>
      ) : null,
    dialog: (
      <Dialog
        open={!!preview}
        title="Review differences prompt"
        description="This visible prompt will be sent once in a separate read-only session. Its cost is reported with the summary."
        onClose={() => setPreview(undefined)}
        actions={
          <>
            <button
              className="btn"
              type="button"
              disabled={disabled}
              onClick={() => setPreview(undefined)}
            >
              Cancel
            </button>
            <button
              className="btn"
              type="button"
              disabled={disabled}
              onClick={() =>
                setPreview((old) => (old ? { ...old, prompt: differencesPrompt(answers) } : old))
              }
            >
              Refresh answers
            </button>
            <button
              className="btn pri"
              type="button"
              disabled={disabled || !preview?.profileId || !!summaryId}
              onClick={() => {
                if (!preview) return;
                void run("compare.differences", {
                  id,
                  profileId: preview.profileId,
                  expectedPrompt: preview.prompt,
                }).then((ok) => {
                  if (ok) {
                    hide(false);
                    setPreview(undefined);
                  }
                });
              }}
            >
              Run differences
            </button>
          </>
        }
      >
        {error ? <p role="alert">{error}</p> : null}
        <label>
          Summary writer
          <select
            value={preview?.profileId ?? ""}
            disabled={disabled}
            onChange={(event) => {
              const profileId = event.target.value;
              setPreview((old) => (old ? { ...old, profileId } : old));
            }}
          >
            {answers.map((a) => (
              <option key={a.threadId} value={a.profileId}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Prompt to send
          <textarea
            className="compare-differences-preview"
            readOnly
            rows={10}
            value={preview?.prompt ?? ""}
          />
        </label>
      </Dialog>
    ),
  };
}
