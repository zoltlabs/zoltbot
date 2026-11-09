import { type Interaction, InteractionSchema, parse } from "@zoltbot/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import { Markdown } from "../chat/Markdown.js";
import { body, type ChatConnection, type Row, text } from "../chat/types.js";
import { Button, Chip } from "../components/primitives.js";
import { InteractionCard } from "../interactions/InteractionCard.js";
import { rowTime } from "./data.js";
import {
  buildReply,
  type Draft,
  emptyDraft,
  itemText,
  type Letter,
  lettersFrom,
  type QuestionRef,
  replyQuestions,
} from "./letters.js";

const quietTools = new Set(["thought", "tool", "plan", "note", "interaction"]);

/**
 * A thread read like a mailing list: earlier letters fold to one line, the newest agent letter is
 * open with its requests, and one reply answers what it quotes.
 */
export function ThreadLetters({
  connection,
  threadId,
  name,
  busy = false,
  steer = false,
  onSent,
  replyRef,
}: {
  connection: ChatConnection;
  threadId: string;
  /** The agent's display name. */
  name: string;
  busy?: boolean;
  steer?: boolean;
  onSent?: (settled: boolean) => void;
  /** Lets the page's R key reach the reply box. */
  replyRef?: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const entities = connection.snapshot.entities;
  const thread = entities.thread?.find((row) => row.id === threadId);
  const items = useMemo(
    () => (entities.item ?? []).filter((row) => row.threadId === threadId),
    [entities.item, threadId],
  );
  const letters = useMemo(() => lettersFrom(items), [items]);
  const newestAgent = [...letters].reverse().find((letter) => letter.from === "agent")?.id;
  const [open, setOpen] = useState<Set<string>>(new Set());
  const questions = useMemo(
    () => replyQuestions(entities.interaction, threadId),
    [entities.interaction, threadId],
  );
  // A card answered here stays to show how it ended, as it would in the chat.
  const shown = useRef(new Set<string>());
  const cards = useMemo(() => {
    const asked = new Set(questions.map((question) => text(question.interaction.id)));
    const result: Interaction[] = [];
    for (const row of entities.interaction ?? []) {
      const id = text(row.id);
      if (row.threadId !== threadId || asked.has(id)) continue;
      if (row.state !== "pending" && !shown.current.has(id)) continue;
      shown.current.add(id);
      try {
        result.push(parse(InteractionSchema, row));
      } catch {}
    }
    return result;
  }, [entities.interaction, questions, threadId]);
  const questionKey = questions.map((q) => `${text(q.interaction.id)}:${q.n}`).join(",");
  const [draft, setDraft] = useState<Draft>(() => emptyDraft(questions));
  // New or answered questions reset what is quoted; typed answers for questions still open stay.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the question set
  useEffect(() => {
    setDraft((previous) => ({ ...previous, quoted: questions.map((question) => question.n) }));
  }, [questionKey]);
  const lettersRef = useRef<HTMLDivElement>(null);
  // ">" quotes the text selected in a letter, as mail clients do.
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key !== ">" || event.metaKey || event.ctrlKey || event.altKey) return;
      if ((event.target as HTMLElement)?.matches("input,textarea,select,[contenteditable=true]"))
        return;
      const selection = window.getSelection(),
        selected = selection?.toString().trim();
      if (
        !selected ||
        !selection?.anchorNode ||
        !lettersRef.current?.contains(selection.anchorNode)
      )
        return;
      event.preventDefault();
      setDraft((previous) => ({ ...previous, quotes: [...previous.quotes, selected] }));
      selection.removeAllRanges();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  if (!thread) return null;
  const toggle = (id: string) =>
    setOpen((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleQuoted = (n: number) =>
    setDraft((previous) => ({
      ...previous,
      quoted: previous.quoted.includes(n)
        ? previous.quoted.filter((value) => value !== n)
        : [...previous.quoted, n].sort((a, b) => a - b),
    }));
  return (
    <div className="letters">
      <div className="letters-list" ref={lettersRef}>
        {letters.length ? null : (
          <p className="letters-empty">Nothing has been said in this conversation yet.</p>
        )}
        {letters.map((letter) =>
          letter.id === newestAgent || open.has(letter.id) || letter.queued ? (
            <LetterBody
              key={letter.id}
              letter={letter}
              name={name}
              collapsible={letter.id !== newestAgent && !letter.queued}
              onCollapse={() => toggle(letter.id)}
            >
              {letter.id === newestAgent ? (
                <>
                  {questions.length ? (
                    <QuestionList
                      questions={questions}
                      quoted={draft.quoted}
                      onToggle={toggleQuoted}
                    />
                  ) : null}
                  {cards.map((request) => (
                    <InteractionCard
                      key={`${request.id}:${request.version}`}
                      request={request}
                      connection={connection}
                      profile={name}
                      autoFocus={false}
                    />
                  ))}
                </>
              ) : null}
            </LetterBody>
          ) : (
            <button
              key={letter.id}
              type="button"
              className="letter-folded"
              aria-expanded={false}
              onClick={() => toggle(letter.id)}
            >
              <span className="letter-from">{letter.from === "you" ? "You" : name}</span>
              <span className="letter-summary truncate">{letter.summary}</span>
              <span className="letter-time">{rowTime(letter.at)}</span>
            </button>
          ),
        )}
        {!newestAgent && (questions.length || cards.length) ? (
          <section className="letter" aria-label={`Requests from ${name}`}>
            {questions.length ? (
              <QuestionList questions={questions} quoted={draft.quoted} onToggle={toggleQuoted} />
            ) : null}
            {cards.map((request) => (
              <InteractionCard
                key={`${request.id}:${request.version}`}
                request={request}
                connection={connection}
                profile={name}
                autoFocus={false}
              />
            ))}
          </section>
        ) : null}
      </div>
      <ReplyComposer
        connection={connection}
        threadId={threadId}
        title={text(thread.title) || "Conversation"}
        questions={questions}
        draft={draft}
        setDraft={setDraft}
        busy={busy}
        steer={steer}
        replyRef={replyRef}
        onSent={(settled) => {
          setDraft(emptyDraft([]));
          onSent?.(settled);
        }}
      />
    </div>
  );
}

function LetterBody({
  letter,
  name,
  collapsible,
  onCollapse,
  children,
}: {
  letter: Letter;
  name: string;
  collapsible: boolean;
  onCollapse: () => void;
  children?: React.ReactNode;
}) {
  const from = letter.from === "you" ? "You" : name;
  const said = letter.items.filter((item) => !quietTools.has(text(item.kind)));
  const tools = letter.items.filter((item) => item.kind === "tool");
  return (
    <article
      className={`letter${letter.from === "you" ? " mine" : ""}`}
      aria-label={`From ${from}`}
    >
      <header className="letter-head">
        {collapsible ? (
          <button type="button" className="letter-from" aria-expanded onClick={onCollapse}>
            {from}
          </button>
        ) : (
          <span className="letter-from">{from}</span>
        )}
        <span className="letter-time">
          {letter.from === "you" ? "" : "to you · "}
          {rowTime(letter.at)}
        </span>
        {letter.queued ? <Chip tone="accent">Queued</Chip> : null}
      </header>
      {said.map((item) => (
        <div key={text(item.id)} className="letter-text">
          <Markdown value={itemText(item)} />
          {body(item).streaming === true ? <span className="dim sm">Writing…</span> : null}
        </div>
      ))}
      {tools.length ? (
        <details className="letter-work">
          <summary>
            Show work · {tools.length} tool {tools.length === 1 ? "call" : "calls"}
          </summary>
          <ul>
            {tools.map((item) => (
              <li key={text(item.id)} className="truncate">
                {text(body(item).title) || text(body(item).name) || "Tool call"}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {children}
    </article>
  );
}

function QuestionList({
  questions,
  quoted,
  onToggle,
}: {
  questions: QuestionRef[];
  quoted: number[];
  onToggle: (n: number) => void;
}) {
  return (
    <ol className="letter-questions" aria-label="Questions">
      {questions.map((question) => (
        <li key={question.n} className="letter-question">
          <span className="letter-q">Q{question.n}</span>
          <span className="letter-prompt">{text(question.item.prompt)}</span>
          <Button
            size="sm"
            variant={quoted.includes(question.n) ? "secondary" : "ghost"}
            aria-pressed={quoted.includes(question.n)}
            aria-label={`Quote question ${question.n} in the reply`}
            onClick={() => onToggle(question.n)}
          >
            {quoted.includes(question.n) ? "Quoted" : "Quote"}
          </Button>
        </li>
      ))}
    </ol>
  );
}

function ReplyComposer({
  connection,
  threadId,
  title,
  questions,
  draft,
  setDraft,
  busy,
  steer,
  replyRef,
  onSent,
}: {
  connection: ChatConnection;
  threadId: string;
  title: string;
  questions: QuestionRef[];
  draft: Draft;
  setDraft: React.Dispatch<React.SetStateAction<Draft>>;
  busy: boolean;
  steer: boolean;
  replyRef?: React.RefObject<HTMLTextAreaElement | null> | undefined;
  onSent: (settled: boolean) => void;
}) {
  const [sending, setSending] = useState(false),
    [error, setError] = useState("");
  // One id per reply, kept across retries so a reply that half-landed is replayed, not repeated.
  const attempt = useRef<string | undefined>(undefined);
  const quoted = questions.filter((question) => draft.quoted.includes(question.n));
  const reply = buildReply(questions, draft);
  const answered = quoted.length - reply.skipped.length;
  const online = connection.status === "online";
  const send = async (settle: boolean) => {
    if (!reply.body || sending || !online) return;
    setSending(true);
    setError("");
    attempt.current ??= crypto.randomUUID();
    try {
      await connection.call(
        "thread.reply",
        {
          threadId,
          body: reply.body,
          answers: reply.answers,
          mode: busy && steer ? "steer" : "queue",
          ...(settle ? { settle: true } : {}),
        },
        `reply:${attempt.current}`,
      );
      attempt.current = undefined;
      onSent(settle);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "";
      setError(
        message.includes("stale_interaction")
          ? "A question changed while you wrote. Check the newest letter and send again."
          : "The reply could not be sent. Sending again will not repeat what already arrived.",
      );
    } finally {
      setSending(false);
    }
  };
  const pick = (question: QuestionRef, id: string) =>
    setDraft((previous) => {
      const current = previous.picks[question.n] ?? [];
      const next = question.item.multi
        ? current.includes(id)
          ? current.filter((value) => value !== id)
          : [...current, id]
        : current.includes(id)
          ? []
          : [id];
      return { ...previous, picks: { ...previous.picks, [question.n]: next } };
    });
  return (
    <form
      className="letter-reply"
      aria-label="Reply"
      onSubmit={(event) => {
        event.preventDefault();
        void send(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          void send(false);
        }
      }}
    >
      <header className="letter-head">
        <span className="letter-from">Reply</span>
        <span className="letter-time truncate">Re: {title}</span>
        <span className="letter-hint">Select text in a letter and press &gt; to quote it</span>
      </header>
      {quoted.map((question) => {
        const options = Array.isArray(question.item.options)
          ? (question.item.options as Row[])
          : [];
        const picks = draft.picks[question.n] ?? [];
        return (
          <fieldset key={question.n} className="letter-answer">
            <legend>
              <blockquote>
                Q{question.n} · {text(question.item.prompt)}
              </blockquote>
            </legend>
            {options.length ? (
              <div className="letter-options">
                {options.map((option) => (
                  <Button
                    key={text(option.id)}
                    size="sm"
                    variant={picks.includes(text(option.id)) ? "primary" : "secondary"}
                    aria-pressed={picks.includes(text(option.id))}
                    onClick={() => pick(question, text(option.id))}
                  >
                    {text(option.label)}
                  </Button>
                ))}
              </div>
            ) : null}
            {question.item.allowOther === false && options.length ? null : (
              <textarea
                className="zb-input"
                rows={2}
                aria-label={`Answer to question ${question.n}`}
                placeholder={options.length ? "Add a note (optional)" : "Your answer"}
                value={draft.other[question.n] ?? ""}
                onChange={(event) =>
                  setDraft((previous) => ({
                    ...previous,
                    other: { ...previous.other, [question.n]: event.target.value },
                  }))
                }
              />
            )}
          </fieldset>
        );
      })}
      {draft.quotes.map((value, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the same text may be quoted twice
        <div key={`${index}:${value}`} className="letter-quote">
          <blockquote>{value}</blockquote>
          <Button
            size="sm"
            variant="ghost"
            aria-label="Remove this quote"
            onClick={() =>
              setDraft((previous) => ({
                ...previous,
                quotes: previous.quotes.filter((_, at) => at !== index),
              }))
            }
          >
            Remove
          </Button>
        </div>
      ))}
      <textarea
        ref={replyRef}
        className="zb-input"
        rows={quoted.length ? 2 : 3}
        aria-label={quoted.length ? "Anything else" : "Reply"}
        placeholder={
          quoted.length ? "Anything else: a new topic, a correction…" : `Reply to ${title}`
        }
        value={draft.extra}
        onChange={(event) => setDraft((previous) => ({ ...previous, extra: event.target.value }))}
      />
      {error ? (
        <p className="letter-error" role="alert">
          {error}
        </p>
      ) : null}
      <footer className="letter-reply-actions">
        <span className="letter-time">
          {quoted.length
            ? `${answered} of ${quoted.length} quoted ${quoted.length === 1 ? "question" : "questions"} answered`
            : busy
              ? steer
                ? "Arrives while the agent works"
                : "Arrives when this turn ends"
              : ""}
        </span>
        <Button
          size="sm"
          disabled={!reply.body || sending || !online}
          onClick={() => void send(true)}
        >
          Send &amp; settle
        </Button>
        <Button
          type="submit"
          size="sm"
          variant="primary"
          kbd="⌘↵"
          disabled={!reply.body || sending || !online}
        >
          {sending ? "Sending…" : "Send reply"}
        </Button>
      </footer>
    </form>
  );
}
