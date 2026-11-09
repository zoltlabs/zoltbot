import type { Interaction } from "@zoltbot/protocol";
import { useEffect, useRef, useState } from "react";
import { DictationControl, useDictation } from "../chat/Dictation.js";
import type { ChiefRecommendation } from "../chief/data.js";
import type { AnswerDraft } from "./actions.js";
import { replyChoices, voiceIntent } from "./voice.js";

/**
 * Speak (or type) to the selected request in Needs you: "accept", "decline", "next", or a reply.
 * Commands act at once, like their keys; a reply waits for you to pick what it becomes.
 */
export function QueueVoice({
  request,
  recommend,
  disabled,
  onAnswer,
  onNext,
}: {
  request: Interaction | undefined;
  recommend: ChiefRecommendation | undefined;
  disabled: boolean;
  onAnswer(request: Interaction, draft: AnswerDraft, summary: string): Promise<boolean>;
  onNext(): void;
}) {
  const [spoken, setSpoken] = useState(""),
    [reply, setReply] = useState<{ text: string; request: Interaction }>(),
    [status, setStatus] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const dictation = useDictation({
    scopeKey: "inbox-voice",
    draft: spoken,
    disabled,
    allowDictation: !request?.items.some((item) => item.secret),
    contextualStrings: ["accept", "decline", "next", "approve", "reject", "skip"],
    editorRef: input,
    onUpdateDraft: (next) => setSpoken(next),
    onError: (message) => message && setStatus(message),
  });
  const run = async (text: string) => {
    const intent = voiceIntent(text, request, recommend);
    setSpoken("");
    if (intent.kind === "next") {
      setReply(undefined);
      setStatus("");
      onNext();
      return;
    }
    if (intent.kind === "none") {
      if (text.trim()) setStatus(intent.why);
      return;
    }
    if (!request) return;
    if (intent.kind === "reply") {
      setStatus("");
      setReply({ text: intent.text, request });
      return;
    }
    setReply(undefined);
    if (await onAnswer(request, intent.draft, intent.summary))
      setStatus(`${intent.summary}: ${request.title || request.items[0]?.prompt || "request"}`);
  };
  // A finished dictation is a submitted command; a cancelled one rolls back to empty and does nothing.
  const listening = useRef(false);
  const latest = useRef(run);
  latest.current = run;
  useEffect(() => {
    if (dictation.active) listening.current = true;
    else if (listening.current) {
      listening.current = false;
      void latest.current(spoken);
    }
  }, [dictation.active, spoken]);
  // A reply belongs to the request it was spoken to.
  const pending = reply && reply.request.id === request?.id ? reply : undefined;
  const choices = pending ? replyChoices(pending.request, pending.text) : [];
  return (
    <section className="inbox-voice" aria-label="Speak to the queue">
      <form
        className="inbox-voice-bar"
        onSubmit={(event) => {
          event.preventDefault();
          void run(spoken);
        }}
      >
        <input
          ref={input}
          value={spoken}
          disabled={disabled}
          aria-label="Command or reply for the selected request"
          placeholder="Say or type: accept, decline, next, or a reply"
          onChange={(event) => setSpoken(event.target.value)}
          onKeyDown={(event) => {
            if (dictation.handleKeyDown(event)) return;
            if (event.key === "Escape" && spoken) {
              event.preventDefault();
              event.stopPropagation();
              setSpoken("");
            }
          }}
          onKeyUp={(event) => dictation.handleKeyUp(event)}
        />
        <DictationControl dictation={dictation} disabled={disabled} label="Speak" iconOnly />
      </form>
      {pending ? (
        <fieldset className="inbox-voice-reply" aria-label="Your reply">
          <p>"{pending.text}"</p>
          {choices.length ? null : (
            <p className="dim">This request needs a choice; open it to answer.</p>
          )}
          <div className="interaction-buttons">
            {choices.map((choice, index) => (
              <button
                key={choice.label}
                type="button"
                className={`btn sm${index ? "" : " pri"}`}
                disabled={disabled}
                onClick={async () => {
                  if (await onAnswer(pending.request, choice.draft, "Sent")) {
                    setReply(undefined);
                    setStatus(`Sent: ${pending.request.title || "request"}`);
                  }
                }}
              >
                {choice.label}
              </button>
            ))}
            <button type="button" className="btn sm" onClick={() => setReply(undefined)}>
              Discard
            </button>
          </div>
        </fieldset>
      ) : null}
      <output className="sm dim" aria-live="polite">
        {status}
      </output>
    </section>
  );
}
