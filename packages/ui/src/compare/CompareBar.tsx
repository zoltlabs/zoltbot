import { useState } from "react";
import { type ChatConnection, text } from "../chat/types.js";
import { Dialog } from "../components/primitives.js";
import { useShell } from "../state.js";
import type { CompareRun } from "./compare-actions.js";
import { answerDraft, compareAnswers } from "./compare-state.js";
export function CompareBar({
  connection,
  id,
  run,
  busy,
  readOnly,
  error,
}: {
  connection: ChatConnection;
  id: string;
  run: CompareRun;
  busy: boolean;
  readOnly: boolean;
  error: string;
}) {
  const [draft, setDraft] = useState(""),
    [merge, setMerge] = useState(false),
    [target, setTarget] = useState(""),
    [review, setReview] = useState<
      { id: string; drafts: { threadId: string; name: string; text: string }[] } | undefined
    >();
  const heldDraft = useShell((s) => s.chatDraft);
  const e = connection.snapshot.entities,
    answers = compareAnswers(e, id),
    members = (e.compareMember ?? []).filter((r) => r.compareId === id);
  const preferred =
    text(members.find((r) => r.vote === "better")?.threadId) || answers[0]?.threadId || "";
  const disabled = busy || connection.status !== "online";
  if (readOnly)
    return (
      <div className="compare-bar">
        <p>This compare is read-only. Open a member as chat to continue its conversation.</p>
        {heldDraft && answers.some((a) => a.threadId === heldDraft.threadId) ? (
          <button
            className="btn"
            type="button"
            onClick={() => useShell.getState().openThread(heldDraft.threadId)}
          >
            Open merge draft
          </button>
        ) : null}
      </div>
    );
  return (
    <div className="compare-bar">
      <form
        className="compare-followup"
        onSubmit={(event) => {
          event.preventDefault();
          if (!draft.trim() || disabled) return;
          void run("compare.send", { id, input: [{ type: "text", text: draft }] }).then((ok) => {
            if (ok) setDraft("");
          });
        }}
      >
        <label className="sr-only" htmlFor="compare-followup">
          Follow up with all
        </label>
        <textarea
          id="compare-followup"
          rows={2}
          value={draft}
          disabled={disabled}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Follow up with all…"
        />
        <button className="btn pri" type="submit" disabled={disabled || !draft.trim()}>
          Send to all
        </button>
      </form>
      <div className="r wrap">
        <button
          className="btn sm"
          type="button"
          disabled={disabled}
          onClick={() => {
            setTarget(preferred);
            setMerge(true);
          }}
        >
          Merge into one…
        </button>
        <button
          className="btn sm"
          type="button"
          disabled={disabled}
          onClick={() =>
            setReview({
              id: crypto.randomUUID(),
              drafts: answers.map((a) => ({
                threadId: a.threadId,
                name: a.name,
                text: answerDraft(
                  "critique",
                  answers.filter((other) => other.threadId !== a.threadId),
                ),
              })),
            })
          }
        >
          Ask each to critique the others
        </button>
        <span className="sp" />
        <button
          className="btn sm"
          type="button"
          disabled={disabled}
          onClick={() => {
            void run("compare.resolve", { id, action: "close" });
          }}
        >
          Close compare
        </button>
      </div>
      <Dialog
        open={merge}
        title="Choose who will merge"
        description="The quoted answers become an editable draft. Nothing is sent until you send it from the chat composer."
        onClose={() => setMerge(false)}
        actions={
          <>
            <button type="button" className="btn" onClick={() => setMerge(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn pri"
              disabled={disabled || !target}
              onClick={() => {
                const draft = answerDraft("merge", answers);
                useShell.setState({ chatDraft: { threadId: target, text: draft } });
                void run("compare.resolve", { id, action: "continue", threadId: target }).then(
                  (ok) => {
                    if (!ok) return;
                    useShell.getState().openThread(target);
                  },
                );
              }}
            >
              Open merge draft
            </button>
          </>
        }
      >
        {error ? <p role="alert">{error}</p> : null}
        <label>
          Merge with
          <select value={target} onChange={(event) => setTarget(event.target.value)}>
            {answers.map((a) => (
              <option key={a.threadId} value={a.threadId}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
      </Dialog>
      <Dialog
        open={!!review}
        title="Review critique drafts"
        description="Edit each draft. The single Send critiques button queues these visible drafts on their member threads."
        onClose={() => setReview(undefined)}
        actions={
          <>
            <button
              type="button"
              className="btn"
              disabled={disabled}
              onClick={() => setReview(undefined)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn pri"
              disabled={disabled || !review?.drafts.every((d) => d.text.trim())}
              onClick={() => {
                if (!review) return;
                void Promise.all(
                  review.drafts.map((d) =>
                    run(
                      "turn.send",
                      {
                        threadId: d.threadId,
                        input: [{ type: "text", text: d.text }],
                        mode: "queue",
                      },
                      `${review.id}:${d.threadId}`,
                    ),
                  ),
                ).then((results) => {
                  if (results.every(Boolean)) setReview(undefined);
                });
              }}
            >
              Send critiques
            </button>
          </>
        }
      >
        {error ? <p role="alert">{error}</p> : null}
        <div className="compare-review">
          {review?.drafts.map((d) => (
            <label key={d.threadId}>
              Critique for {d.name}
              <textarea
                rows={8}
                value={d.text}
                disabled={disabled}
                onChange={(event) => {
                  const value = event.target.value;
                  setReview((old) =>
                    old
                      ? {
                          ...old,
                          drafts: old.drafts.map((item) =>
                            item.threadId === d.threadId ? { ...item, text: value } : item,
                          ),
                        }
                      : old,
                  );
                }}
              />
            </label>
          ))}
        </div>
      </Dialog>
    </div>
  );
}
export function CompareMemberActions({
  name,
  threadId,
  id,
  vote,
  run,
  disabled,
  readOnly,
  onContinue,
  primary,
}: {
  primary: boolean;
  name: string;
  threadId: string;
  id: string;
  vote: boolean;
  run: CompareRun;
  disabled: boolean;
  readOnly: boolean;
  onContinue(threadId: string): Promise<void>;
}) {
  return (
    <footer className="compare-member-actions">
      <button
        className={`btn sm${primary ? " pri" : ""}`}
        type="button"
        disabled={disabled || readOnly}
        onClick={() => {
          void onContinue(threadId);
        }}
      >
        Continue with {name}
      </button>
      <button
        className="btn sm"
        type="button"
        aria-pressed={vote}
        disabled={disabled || readOnly}
        onClick={() => {
          void run("compare.vote", { id, threadId, vote: vote ? null : "better" });
        }}
      >
        Better
      </button>
      <button
        className="btn sm"
        type="button"
        onClick={() => useShell.getState().openThread(threadId)}
      >
        Open as chat
      </button>
    </footer>
  );
}
