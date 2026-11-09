import type { Interaction, InteractionAnswer } from "@zoltbot/protocol";
import { useRef, useState } from "react";
import { type ChatConnection, text } from "../chat/types.js";
import type { ChiefTriage } from "../chief/data.js";
import { describeAnswer, recommendedAnswer } from "./batch.js";

type Review = {
  selection: string;
  id: string;
  mode: "recommended" | "skip";
  requests: Interaction[];
  items: { id: string; version: number; answer: InteractionAnswer }[];
};
export function BatchActions({
  connection,
  requests,
  pending,
  setPending,
  onComplete,
  triage = {},
  reviewRef,
}: {
  connection: ChatConnection;
  requests: Interaction[];
  /** Zolt's recommendations, which "Review recommended" uses first. */
  triage?: Record<string, ChiefTriage>;
  /** Lets the page start a review, as "Accept all Zolt's picks" does. */
  reviewRef?: { current: (() => void) | undefined };
  pending: boolean;
  setPending(value: boolean): void;
  onComplete(): void;
}) {
  const [review, setReview] = useState<Review>(),
    [error, setError] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const recommendButton = useRef<HTMLButtonElement>(null);
  const skipButton = useRef<HTMLButtonElement>(null);
  const selection = JSON.stringify(requests.map((request) => [request.id, request.version]));
  const current = review?.selection === selection ? review : undefined;
  const draftFor = (request: Interaction) =>
    recommendedAnswer(request, triage[request.id]?.recommend);
  const recommended = requests.every((request) => draftFor(request));
  const tooMany = requests.length > 100;
  const disabled = pending || connection.status !== "online" || tooMany;
  const prepare = (mode: Review["mode"]) => {
    const at = new Date().toISOString();
    if (disabled || (mode === "recommended" && !recommended)) return;
    const items = requests.map((request) => {
      const draft = mode === "skip" ? { action: "cancel" as const } : draftFor(request);
      if (!draft) throw new Error("recommendation_unavailable");
      return {
        id: request.id,
        version: request.version,
        answer: { ...draft, at, by: { kind: "human" as const, id: "local-owner" } },
      };
    });
    setError("");
    setReview({
      selection,
      id: crypto.randomUUID(),
      mode,
      requests: structuredClone(requests),
      items,
    });
    requestAnimationFrame(() => heading.current?.focus());
  };
  if (reviewRef) reviewRef.current = () => prepare("recommended");
  const send = async () => {
    if (!current || disabled) return;
    setPending(true);
    setError("");
    try {
      await connection.call("interaction.batchAnswer", { items: current.items }, current.id);
      setReview(undefined);
      onComplete();
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : "";
      setError(
        code.includes("conflict") || code.includes("stale")
          ? "A selected request changed. Review the current requests before trying again."
          : "The batch could not be confirmed. Review the requests or retry this same batch.",
      );
    } finally {
      setPending(false);
    }
  };
  return (
    <>
      <button
        type="button"
        className="btn sm"
        ref={recommendButton}
        disabled={disabled || !recommended}
        onClick={() => prepare("recommended")}
      >
        Review recommended
      </button>
      <button
        ref={skipButton}
        type="button"
        className="btn sm"
        disabled={disabled}
        onClick={() => prepare("skip")}
      >
        Skip selected
      </button>
      {tooMany ? <p className="sm dim">Select up to 100 requests for one answer batch.</p> : null}
      {!recommended ? (
        <p className="sm dim">
          Review recommended needs a recommendation for every selected item, from Zolt or the
          request itself.
        </p>
      ) : null}
      {current ? (
        <section className="inbox-batch-review" aria-label="Review batch answers">
          <h2 ref={heading} tabIndex={-1}>
            {current.mode === "skip" ? "Skip selected requests" : "Review recommended answers"}
          </h2>
          <p>
            {current.requests.length} {current.requests.length === 1 ? "request" : "requests"}.
            Review each answer before sending. Changed requests will require a new review.
          </p>
          <ol>
            {current.requests.map((request) => (
              <li key={request.id}>
                <strong>
                  {request.title ||
                    `Request from ${text(connection.snapshot.entities.agent?.find((profile) => profile.id === request.agentId)?.name) || "profile"}`}
                </strong>{" "}
                {current.mode === "recommended" ? (
                  <p>
                    {describeAnswer(
                      request,
                      current.items.find((item) => item.id === request.id)?.answer ?? {
                        action: "cancel",
                      },
                    )}
                    {triage[request.id]?.why ? (
                      <span className="dim"> · {triage[request.id]?.why}</span>
                    ) : null}
                  </p>
                ) : (
                  <p>
                    {request.items.map((item) => item.prompt).join(" · ")}
                    <br />
                    Cancel this request without an answer.
                  </p>
                )}
              </li>
            ))}
          </ol>
          <div className="interaction-buttons">
            <button
              type="button"
              className="btn pri"
              disabled={disabled}
              onClick={() => void send()}
            >
              {pending
                ? "Sending…"
                : current.mode === "skip"
                  ? "Confirm skip"
                  : "Send recommended answers"}
            </button>
            <button
              type="button"
              className="btn"
              disabled={pending}
              onClick={() => {
                setReview(undefined);
                setError("");
                requestAnimationFrame(() =>
                  (current.mode === "skip" ? skipButton : recommendButton).current?.focus(),
                );
              }}
            >
              Back to requests
            </button>
          </div>
        </section>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </>
  );
}
