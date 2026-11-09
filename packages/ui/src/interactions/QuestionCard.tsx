import type { Interaction, InteractionAnswer } from "@zoltbot/protocol";
import { useEffect, useRef, useState } from "react";
import type { AnswerDraft } from "./actions.js";

type Answer = NonNullable<InteractionAnswer["answers"]>[string];
export function QuestionCard({
  request,
  disabled,
  submit,
}: {
  request: Interaction;
  disabled: boolean;
  submit(answer: AnswerDraft): Promise<void>;
}) {
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<Record<string, Answer>>(() =>
    Object.fromEntries(
      request.items.map((item) => [
        item.id,
        {
          options: (item.options ?? [])
            .filter((option) => option.recommended)
            .slice(0, item.multi ? undefined : 1)
            .map((option) => option.id),
        },
      ]),
    ),
  );
  const other = useRef<HTMLInputElement>(null);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    form.current
      ?.querySelector<HTMLElement>(
        `[data-question-step="${step}"] input, [data-question-step="${step}"] button`,
      )
      ?.focus();
  }, [step]);
  const item = request.items[step],
    review = !item;
  const update = (value: Answer) => {
    if (item) setAnswers((current) => ({ ...current, [item.id]: value }));
  };
  const value = item ? (answers[item.id] ?? {}) : {};
  const choose = (id: string) => {
    if (!item) return;
    const selected = value.options ?? [];
    update({
      ...(item.multi ? value : {}),
      options: item.multi
        ? selected.includes(id)
          ? selected.filter((entry) => entry !== id)
          : [...selected, id]
        : [id],
    });
  };
  const valid =
    review ||
    !!value.options?.length ||
    !!value.other?.trim() ||
    (typeof value.value === "string" && !!value.value.trim());
  const proceed = () => {
    if (!valid || disabled) return;
    if (!review && request.items.length > 1) setStep(step + 1);
    else void submit({ action: "accept", answers });
  };
  return (
    <form
      ref={form}
      className="interaction-question"
      onSubmit={(event) => {
        event.preventDefault();
        proceed();
      }}
      onKeyDown={(event) => {
        if (disabled || !item || event.metaKey || event.ctrlKey || event.altKey) return;
        const target = event.target as HTMLElement;
        if (target.matches('input:not([type="radio"]):not([type="checkbox"]), textarea')) return;
        if ((event.key === "o" || event.key === "/") && item.allowOther !== false) {
          event.preventDefault();
          other.current?.focus();
          return;
        }
        const index = Number(event.key) - 1,
          option = /^[1-9]$/.test(event.key) ? item.options?.[index] : undefined;
        if (option) {
          event.preventDefault();
          choose(option.id);
          if (request.items.length > 1 && !item.multi) setStep(step + 1);
        }
      }}
    >
      {item ? (
        <fieldset disabled={disabled} data-question-step={step}>
          <legend>{item.prompt}</legend>
          {request.items.length > 1 ? (
            <p className="sm dim">
              Question {step + 1} of {request.items.length}
            </p>
          ) : null}
          <div className="interaction-options">
            {(item.options ?? []).map((option, index) => (
              <label
                key={option.id}
                className={`opt${value.options?.includes(option.id) ? " sel" : ""}`}
              >
                <input
                  type={item.multi ? "checkbox" : "radio"}
                  name={`question-${request.id}-${item.id}`}
                  checked={value.options?.includes(option.id) ?? false}
                  onChange={() => choose(option.id)}
                />
                <span className="kbd" aria-hidden="true">
                  {index + 1}
                </span>
                <span className="grow">
                  <strong>{option.label}</strong>
                  {option.recommended ? <span className="chip acc">Recommended</span> : null}
                  {option.description ? (
                    option.description.length > 160 ? (
                      <details>
                        <summary>{option.description.slice(0, 160)}…</summary>
                        <p>{option.description}</p>
                      </details>
                    ) : (
                      <span className="interaction-description dim">{option.description}</span>
                    )
                  ) : null}
                </span>
              </label>
            ))}
          </div>
          {item.allowOther !== false || !item.options?.length ? (
            <label className="interaction-other">
              {item.secret ? "Private answer" : item.options?.length ? "Other" : "Your answer"}
              <input
                ref={other}
                type={item.secret ? "password" : "text"}
                autoComplete="off"
                onFocus={() => {
                  if (!item.multi && value.options?.length)
                    update(
                      item.secret ? { value: value.value ?? "" } : { other: value.other ?? "" },
                    );
                }}
                value={item.secret ? String(value.value ?? "") : (value.other ?? "")}
                onChange={(event) =>
                  update(
                    item.secret
                      ? { value: event.target.value }
                      : { ...(item.multi ? value : {}), other: event.target.value },
                  )
                }
              />
            </label>
          ) : null}
        </fieldset>
      ) : (
        <section aria-label="Review answers" data-question-step={step}>
          <h3>Review answers</h3>
          <dl>
            {request.items.map((entry, index) => {
              const answer = answers[entry.id];
              return (
                <div key={entry.id}>
                  <dt>{entry.prompt}</dt>
                  <dd>
                    {entry.secret
                      ? "Private value provided"
                      : [
                          ...(entry.options ?? [])
                            .filter((option) => answer?.options?.includes(option.id))
                            .map((option) => option.label),
                          answer?.other ?? "",
                        ]
                          .filter(Boolean)
                          .join(", ")}{" "}
                    <button type="button" className="btn sm" onClick={() => setStep(index)}>
                      Edit answer {index + 1}
                    </button>
                  </dd>
                </div>
              );
            })}
          </dl>
        </section>
      )}
      <div className="interaction-buttons">
        {step > 0 ? (
          <button
            type="button"
            className="btn"
            disabled={disabled}
            onClick={() => setStep(step - 1)}
          >
            Back
          </button>
        ) : null}
        <button type="submit" className="btn pri" disabled={disabled || !valid}>
          {review
            ? "Send answers"
            : request.items.length === 1
              ? "Send answer"
              : step === request.items.length - 1
                ? "Review answers"
                : "Next"}
        </button>
      </div>
    </form>
  );
}
