import type { Interaction } from "@zoltbot/protocol";
import { useEffect, useRef, useState } from "react";
import { useDictation } from "../chat/Dictation.js";
import type { ChatConnection } from "../chat/types.js";
import { Avatar, Button, Chip, Dialog } from "../components/primitives.js";
import { validSuggestion } from "../rules/rule-data.js";
import { AlwaysAllowRule } from "./AlwaysAllowRule.js";
import { type AnswerDraft, useInteractionActions } from "./actions.js";
import { FormCard } from "./FormCard.js";
import { QuestionCard } from "./QuestionCard.js";
import { ApprovalActions, PlanActions } from "./RequestActions.js";
import { FeedbackField, RequestContext } from "./RequestContext.js";
import { linkOnlyForm, planApproval, requestChoices } from "./request-data.js";
import { permissionExpansion } from "./request-presentation.js";
import { SavedResolution } from "./SavedResolution.js";
import "./interactions.css";
import "./approval.css";

export function InteractionCard({
  request,
  connection,
  profile,
  onDeferred,
  autoFocus = true,
}: {
  request: Interaction;
  connection: ChatConnection;
  profile: string;
  onDeferred?: () => void;
  /** Take focus when shown, so its keys work at once. Off for a card scrolled back into view. */
  autoFocus?: boolean;
}) {
  const actions = useInteractionActions(connection, request, onDeferred);
  const [confirmation, setConfirmation] = useState<{ draft: AnswerDraft; version: number }>();
  const submit = async (draft: AnswerDraft) => {
    if (permissionExpansion(request, draft.choice))
      setConfirmation({ draft, version: request.version });
    else await actions.submit(draft);
  };
  const [feedback, setFeedback] = useState(""),
    [explaining, setExplaining] = useState(false),
    [alwaysAllow, setAlwaysAllow] = useState(false);
  const feedbackInput = useRef<HTMLTextAreaElement>(null);
  const root = useRef<HTMLElement>(null);
  const entities = connection.snapshot.entities,
    agent = entities.agent?.find((row) => row.id === request.agentId);
  const hasSecretItem = request.items.some((item) => item.secret === true);
  const feedbackDictation = useDictation({
    scopeKey: `interaction-feedback-${request.id}`,
    draft: feedback,
    disabled: actions.pending || connection.status !== "online",
    allowDictation: !hasSecretItem,
    editorRef: feedbackInput,
    onUpdateDraft: (nextDraft) => setFeedback(nextDraft),
  });
  // Read once: a card scrolled back into view must not take focus again.
  const focusOnShow = useRef(autoFocus);
  useEffect(() => {
    if (focusOnShow.current && request.type !== "question" && request.state === "pending")
      root.current?.focus();
  }, [request.type, request.state]);
  useEffect(() => {
    const comment = (event: KeyboardEvent) => {
      if (
        request.type !== "plan" ||
        request.state !== "pending" ||
        event.key !== "c" ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        (event.target as HTMLElement)?.matches("input,textarea")
      )
        return;
      const selection = window.getSelection();
      if (
        !selection?.toString().trim() ||
        !selection.anchorNode ||
        !selection.focusNode ||
        !root.current?.contains(selection.anchorNode) ||
        !root.current.contains(selection.focusNode)
      )
        return;
      event.preventDefault();
      setFeedback(
        (previous) =>
          `${previous}${previous ? "\n\n" : ""}Quoted text: ${selection.toString()}\nComment: `,
      );
      feedbackInput.current?.focus();
    };
    window.addEventListener("keydown", comment);
    return () => window.removeEventListener("keydown", comment);
  }, [request.type, request.state]);
  const disabled = actions.pending || connection.status !== "online";
  const choices = requestChoices(request);
  const suggestion = request.context?.ruleSuggestion;
  const canAlwaysAllow =
    request.type === "approval" && choices.has("allow_once") && validSuggestion(suggestion);
  const withFeedback = feedback.trim() ? { feedback } : {};
  const approve = () => {
    if (choices.has("allow_once"))
      void actions.submit({ action: "accept", choice: "allow_once", ...withFeedback });
  };
  const reject = () => void actions.submit({ action: "decline", ...withFeedback });
  const explain = () => {
    setAlwaysAllow(false);
    setExplaining(true);
    requestAnimationFrame(() => feedbackInput.current?.focus());
  };
  const feedbackField = (placeholder?: string) => (
    <FeedbackField
      id={`interaction-feedback-${request.id}`}
      value={feedback}
      onChange={setFeedback}
      inputRef={feedbackInput}
      dictation={feedbackDictation}
      disabled={disabled}
      {...(placeholder ? { placeholder } : {})}
    />
  );
  return (
    <article
      ref={root}
      tabIndex={-1}
      className={`zb-card interaction-card${request.state === "pending" ? " attention" : ""}`}
      aria-label={`${request.type} from ${profile}`}
      onKeyDown={(event) => {
        if (
          confirmation ||
          request.state !== "pending" ||
          disabled ||
          event.metaKey ||
          event.ctrlKey ||
          event.altKey
        )
          return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          void actions.defer();
          return;
        }
        if (
          (event.target as HTMLElement).matches(
            'input:not([type="radio"]):not([type="checkbox"]),textarea,select,[contenteditable=true]',
          )
        )
          return;
        if (request.type === "question" && event.key === "s") {
          event.preventDefault();
          void actions.submit({ action: "cancel" });
        }
        if (request.type === "plan" && event.key === "Enter") {
          if ((event.target as HTMLElement).matches("button,a,summary")) return;
          event.preventDefault();
          void actions.submit(planApproval(choices, feedback));
          return;
        }
        if (request.type !== "approval") return;
        if (event.key === "y") {
          event.preventDefault();
          approve();
        }
        if (event.key === "s" && choices.has("allow_session")) {
          event.preventDefault();
          void submit({ action: "accept", choice: "allow_session", ...withFeedback });
        }
        if (event.key === "a" && canAlwaysAllow) {
          event.preventDefault();
          setExplaining(false);
          setAlwaysAllow(true);
        }
        if (event.key === "n") {
          event.preventDefault();
          reject();
        }
        if (event.key === "r") {
          event.preventDefault();
          explain();
        }
      }}
    >
      <header className="interaction-heading">
        <Avatar
          name={profile}
          id={request.agentId}
          size={24}
          tool={typeof agent?.definitionId === "string" ? agent.definitionId : undefined}
        />
        <div className="grow">
          <span className="interaction-profile">{profile}</span>
          <h2>
            {request.title ||
              (request.type === "question"
                ? "A question for you"
                : request.type === "plan"
                  ? "Review the plan"
                  : request.type === "approval"
                    ? "Approval needed"
                    : "Review this request")}
          </h2>
        </div>
        <Chip
          tone={request.state === "pending" ? "attention" : "neutral"}
          dot={request.state === "pending"}
        >
          {request.state === "pending" ? request.type : request.state}
        </Chip>
      </header>
      {request.chain.length ? (
        <p className="interaction-chain">
          Asked through {request.chain.map((actor) => `${actor.kind}: ${actor.id}`).join(" → ")}
        </p>
      ) : null}
      {actions.error ? (
        <p className="interaction-error" role="alert">
          {actions.error}
        </p>
      ) : null}
      {request.state !== "pending" ? (
        <SavedResolution request={request} connection={connection} />
      ) : (
        <>
          <RequestContext request={request} />
          {request.type === "question" ? (
            <QuestionCard request={request} disabled={disabled} submit={submit} />
          ) : request.type === "approval" ? (
            <ApprovalActions
              request={request}
              choices={choices}
              disabled={disabled}
              feedback={explaining ? feedback : ""}
              explaining={explaining}
              ruleOpen={alwaysAllow && canAlwaysAllow}
              canAlwaysAllow={canAlwaysAllow}
              submit={submit}
              onExplain={explain}
              onAlwaysAllow={() => {
                setExplaining(false);
                setAlwaysAllow(true);
              }}
            >
              {alwaysAllow && canAlwaysAllow && suggestion ? (
                <AlwaysAllowRule
                  connection={connection}
                  request={request}
                  suggestion={suggestion}
                  disabled={disabled}
                  onCreated={() => void actions.submit({ action: "accept", choice: "allow_once" })}
                  onCancel={() => {
                    setAlwaysAllow(false);
                    root.current?.focus();
                  }}
                />
              ) : explaining ? (
                feedbackField()
              ) : null}
            </ApprovalActions>
          ) : request.type === "plan" || request.type === "gate" ? (
            <PlanActions
              request={request}
              choices={choices}
              disabled={disabled}
              feedback={feedback}
              submit={submit}
              onNeedFeedback={() => feedbackInput.current?.focus()}
            >
              {feedbackField("Comments or requested changes")}
            </PlanActions>
          ) : (
            <FormCard request={request} disabled={disabled} submit={submit} decline={reject} />
          )}
          <footer className="interaction-buttons interaction-footer">
            <span className="sp" />
            {actions.pending ? <span aria-live="polite">Sending…</span> : null}
            {request.type === "form" && linkOnlyForm(request) ? null : (
              <button
                type="button"
                className="btn sm interaction-ghost"
                disabled={disabled}
                onClick={() => void actions.submit({ action: "cancel" })}
              >
                {request.type === "form" ? "Cancel" : "Skip"}
              </button>
            )}
            <button
              type="button"
              className="btn sm interaction-ghost"
              disabled={disabled}
              onClick={() => void actions.defer()}
            >
              Defer <span className="kbd">Esc</span>
            </button>
          </footer>
        </>
      )}
      {confirmation ? (
        <Dialog
          open
          title={
            permissionExpansion(request, confirmation.draft.choice)?.title ?? "Review permission"
          }
          description={permissionExpansion(request, confirmation.draft.choice)?.description ?? ""}
          onClose={() => setConfirmation(undefined)}
          actions={
            <>
              <Button onClick={() => setConfirmation(undefined)}>Cancel</Button>
              <Button
                disabled={
                  disabled ||
                  request.state !== "pending" ||
                  request.version !== confirmation.version
                }
                onClick={() => {
                  const draft = confirmation.draft;
                  setConfirmation(undefined);
                  void actions.submit(draft);
                }}
              >
                {permissionExpansion(request, confirmation.draft.choice)?.action ?? "Approve"}
              </Button>
            </>
          }
        >
          {request.version !== confirmation.version ? (
            <p role="alert">This request changed. Cancel and review the latest version.</p>
          ) : null}
        </Dialog>
      ) : null}
    </article>
  );
}
