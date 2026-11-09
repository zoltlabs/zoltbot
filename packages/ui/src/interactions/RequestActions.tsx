import type { Interaction } from "@zoltbot/protocol";
import { type FocusEvent, type KeyboardEvent, type ReactNode, useRef, useState } from "react";
import type { AnswerDraft } from "./actions.js";
import { type Choices, planApproval, reversibility, withFeedback } from "./request-data.js";

/**
 * §8.2 as T3 lays it out: Decline (n) · Approve (y) · More. More holds Allow for session (s),
 * Always allow (a) and a reason for declining (r); the keys work without opening it.
 * While the always-allow rule is open, the panel's own action is the only decision shown.
 */
export function ApprovalActions({
  request,
  choices,
  disabled,
  feedback,
  explaining,
  ruleOpen,
  canAlwaysAllow,
  submit,
  onExplain,
  onAlwaysAllow,
  children,
}: {
  request: Interaction;
  choices: Choices;
  disabled: boolean;
  feedback: string;
  explaining: boolean;
  ruleOpen: boolean;
  canAlwaysAllow: boolean;
  submit(answer: AnswerDraft): Promise<void>;
  onExplain(): void;
  onAlwaysAllow(): void;
  /** The reason field or rule preview, shown under the buttons. */
  children?: ReactNode;
}) {
  const session = choices.get("allow_session");
  const undo = reversibility(request);
  const [more, setMore] = useState(false);
  const moreBox = useRef<HTMLSpanElement>(null),
    moreButton = useRef<HTMLButtonElement>(null);
  const closeMore = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !more) return;
    event.preventDefault();
    event.stopPropagation();
    setMore(false);
    moreButton.current?.focus();
  };
  const leaveMore = (event: FocusEvent) => {
    if (!moreBox.current?.contains(event.relatedTarget as Node | null)) setMore(false);
  };
  return (
    <>
      {request.items.map((item) => (
        <p className="interaction-prompt" key={item.id}>
          {item.prompt}
        </p>
      ))}
      {undo ? (
        <p className={`interaction-undo ${undo.level}`}>
          <strong>{undo.label}.</strong> {undo.detail}
        </p>
      ) : null}
      {ruleOpen ? null : (
        <div className="interaction-buttons">
          <button
            type="button"
            className="btn"
            disabled={disabled}
            onClick={() => void submit({ action: "decline", ...withFeedback(feedback) })}
          >
            Decline <span className="kbd">N</span>
          </button>
          {choices.has("allow_once") ? (
            <button
              type="button"
              className="btn pri"
              disabled={disabled}
              onClick={() =>
                void submit({ action: "accept", choice: "allow_once", ...withFeedback(feedback) })
              }
            >
              Approve <span className="kbd">Y</span>
            </button>
          ) : null}
          <span className="interaction-more" ref={moreBox}>
            <button
              ref={moreButton}
              type="button"
              className="btn"
              aria-haspopup="menu"
              aria-expanded={more}
              onClick={() => setMore((value) => !value)}
              onKeyDown={closeMore}
              onBlur={leaveMore}
            >
              More
            </button>
            {more ? (
              <span
                className="interaction-more-menu"
                role="menu"
                aria-label="More approval options"
                onKeyDown={closeMore}
                onBlur={leaveMore}
              >
                {session ? (
                  <button
                    type="button"
                    role="menuitem"
                    className="btn interaction-ghost"
                    disabled={disabled}
                    title={
                      session.label ? `Allows ${session.label} until this session ends` : undefined
                    }
                    onClick={() =>
                      void submit({
                        action: "accept",
                        choice: "allow_session",
                        ...withFeedback(feedback),
                      })
                    }
                  >
                    Allow for session
                    {session.label ? (
                      <code className="interaction-choice-label">{session.label}</code>
                    ) : null}
                    <span className="kbd">S</span>
                  </button>
                ) : null}
                {canAlwaysAllow ? (
                  <button
                    type="button"
                    role="menuitem"
                    className="btn interaction-ghost"
                    disabled={disabled}
                    onClick={onAlwaysAllow}
                  >
                    Always allow… <span className="kbd">A</span>
                  </button>
                ) : null}
                {explaining ? null : (
                  <button
                    type="button"
                    role="menuitem"
                    className="btn interaction-ghost"
                    disabled={disabled}
                    aria-keyshortcuts="R"
                    onClick={onExplain}
                  >
                    Decline with a reason <span className="kbd">R</span>
                  </button>
                )}
              </span>
            ) : null}
          </span>
        </div>
      )}
      {children}
    </>
  );
}

/** §8.3 plan review and gates. Feedback typed with an approval travels as answer.feedback. */
export function PlanActions({
  request,
  choices,
  disabled,
  feedback,
  submit,
  onNeedFeedback,
  children,
}: {
  request: Interaction;
  choices: Choices;
  disabled: boolean;
  feedback: string;
  submit(answer: AnswerDraft): Promise<void>;
  /** Keep planning and Request changes need feedback; this moves focus to the field. */
  onNeedFeedback(): void;
  /** The feedback field, shown above the buttons. */
  children: ReactNode;
}) {
  const [hint, setHint] = useState(false);
  const plan = request.type === "plan";
  const autoAccept = plan && choices.has("allow_accept_edits");
  return (
    <>
      {children}
      <div className="interaction-buttons">
        <button
          type="button"
          className="btn pri"
          disabled={disabled}
          onClick={() => void submit(planApproval(choices, feedback))}
        >
          {autoAccept ? "Approve, review each edit" : "Approve"}
          {plan ? <span className="kbd">Enter</span> : null}
        </button>
        {autoAccept ? (
          // Widens what runs without asking, so it is never the Enter default (I13).
          <button
            type="button"
            className="btn"
            disabled={disabled}
            onClick={() =>
              void submit({
                action: "accept",
                choice: "allow_accept_edits",
                ...withFeedback(feedback),
              })
            }
          >
            Approve and auto-accept edits
          </button>
        ) : null}
        <button
          type="button"
          className="btn"
          disabled={disabled}
          onClick={() => {
            if (feedback.trim()) void submit({ action: "decline", feedback });
            else {
              setHint(true);
              onNeedFeedback();
            }
          }}
        >
          {plan ? "Keep planning" : "Request changes"}
        </button>
        <button
          type="button"
          className="btn bad"
          disabled={disabled}
          onClick={() => void submit({ action: "decline", ...withFeedback(feedback) })}
        >
          Reject
        </button>
      </div>
      {hint && !feedback.trim() ? (
        <output className="interaction-feedback-hint">
          Write what should change in Feedback first.
        </output>
      ) : null}
    </>
  );
}
