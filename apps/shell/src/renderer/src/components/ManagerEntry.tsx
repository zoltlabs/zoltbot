import { createSignal, For, onCleanup, Show } from "solid-js";
import type {
  ConversationNotice,
  DelegationRow,
  ManagerCard,
  TaskActionInput,
  TaskStatus,
} from "../../../shared/ipc";
import type { BotMessage, BotProfile } from "../data";
import { AgentAvatar } from "./AgentAvatar";
import { StaffCard } from "./StaffCard";
import "../manager.css";

type ResultCard = Extract<ManagerCard, { kind: "result" }>;
type StaffCardData = Extract<ManagerCard, { kind: "staff" }>;

interface EntryProps {
  message: BotMessage;
  bots: BotProfile[];
  onSelectAgent: (botId: string) => void;
}

/** A notice line or a delegation or result card in a manager's chat. */
export function ManagerEntry(props: EntryProps) {
  return (
    <Show
      when={props.message.card}
      fallback={
        <Show when={props.message.notice}>
          {(notice) => <NoticeRow notice={notice()} onSelectAgent={props.onSelectAgent} />}
        </Show>
      }
    >
      {(card) => (
        <Show
          when={card().kind === "delegation" ? (card() as { rows: DelegationRow[] }) : undefined}
          fallback={
            <Show
              when={card().kind === "staff" ? (card() as StaffCardData) : undefined}
              fallback={
                <ResultCardView
                  card={card() as ResultCard}
                  bots={props.bots}
                  onSelectAgent={props.onSelectAgent}
                />
              }
            >
              {(staff) => <StaffCard card={staff()} />}
            </Show>
          }
        >
          {(delegation) => (
            <DelegationCard
              rows={delegation().rows}
              bots={props.bots}
              onSelectAgent={props.onSelectAgent}
            />
          )}
        </Show>
      )}
    </Show>
  );
}

const run = (input: TaskActionInput) => window.openbot.agent.taskAction(input);
const message = (error: unknown) =>
  error instanceof Error
    ? error.message.replace(/^Error invoking remote method '[^']+': /, "")
    : "";

function NameButton(props: {
  who: { name: string; botId: string | null };
  onSelectAgent: (botId: string) => void;
}) {
  return (
    <Show when={props.who.botId} fallback={<span>{props.who.name}</span>}>
      {(botId) => (
        <button
          type="button"
          class="manager-notice-name"
          onClick={() => props.onSelectAgent(botId())}
        >
          {props.who.name}
        </button>
      )}
    </Show>
  );
}

function NoticeRow(props: { notice: ConversationNotice; onSelectAgent: (botId: string) => void }) {
  const [open, setOpen] = createSignal(false);
  const [waking, setWaking] = createSignal(false);
  const [error, setError] = createSignal("");
  const detailId = `notice-${Math.random().toString(36).slice(2)}`;
  async function wakeNow() {
    const { threadId, waitId } = props.notice;
    if (!threadId || !waitId || waking()) return;
    setWaking(true);
    setError("");
    try {
      await run({ action: "wake_now", threadId, waitId });
    } catch (failure) {
      setWaking(false);
      setError(message(failure) || "Couldn't wake it. Try again.");
    }
  }
  return (
    <div class="manager-notice-entry">
      <p
        class="manager-notice"
        classList={{ "manager-notice-waiting": props.notice.kind === "waiting" }}
      >
        <Show when={props.notice.from}>
          {(from) => <NameButton who={from()} onSelectAgent={props.onSelectAgent} />}
        </Show>
        <Show when={props.notice.to}>
          {(to) => (
            <>
              <span aria-hidden="true">→</span>
              <span class="sr-only">to</span>
              <span class="manager-notice-to">
                <NameButton who={to()} onSelectAgent={props.onSelectAgent} />:
              </span>
            </>
          )}
        </Show>
        <Show when={props.notice.verb}>
          <span>{props.notice.verb}</span>
        </Show>
        <Show when={props.notice.text}>
          <strong class="manager-notice-text">{props.notice.text}</strong>
        </Show>
        <Show when={props.notice.meta}>
          <span class="manager-notice-meta">· {props.notice.meta}</span>
        </Show>
        <Show when={props.notice.detail && props.notice.detail !== props.notice.text}>
          <button
            type="button"
            class="manager-link"
            aria-expanded={open()}
            aria-controls={detailId}
            onClick={() => setOpen(!open())}
          >
            {open() ? "Hide" : "Show"}
          </button>
        </Show>
        <Show when={props.notice.kind === "waiting"}>
          <button
            type="button"
            class="manager-link"
            disabled={waking()}
            onClick={() => void wakeNow()}
          >
            {waking() ? "Waking…" : "Wake now"}
          </button>
        </Show>
      </p>
      <Show when={open()}>
        <p id={detailId} class="manager-notice-detail">
          {props.notice.detail}
        </p>
      </Show>
      <Show when={error()}>
        <p class="manager-error" role="alert">
          {error()}
        </p>
      </Show>
    </div>
  );
}

const STATUS_LABELS: Record<TaskStatus, string> = {
  queued: "Queued",
  running: "Running",
  blocked: "Blocked",
  review: "Ready for review",
  completed: "Accepted",
  failed: "Failed",
  cancelled: "Stopped",
};
const ACTIVE: TaskStatus[] = ["queued", "running", "blocked"];

function elapsed(from: string | undefined, to: string | undefined, now: number): string {
  if (!from) return "";
  const minutes = Math.max(0, Math.round(((to ? Date.parse(to) : now) - Date.parse(from)) / 60000));
  if (minutes < 1) return "under 1 min";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
}
const usd = (value: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value);
function spend(costUsd?: number, budgetUsd?: number): string {
  if (costUsd === undefined) return budgetUsd === undefined ? "" : `${usd(budgetUsd)} budget`;
  return budgetUsd === undefined ? usd(costUsd) : `${usd(costUsd)} of ${usd(budgetUsd)}`;
}
const botFor = (bots: BotProfile[], id: string | null) => bots.find((bot) => bot.id === id);

function DelegationCard(props: {
  rows: DelegationRow[];
  bots: BotProfile[];
  onSelectAgent: (botId: string) => void;
}) {
  const [now, setNow] = createSignal(Date.now());
  const timer = setInterval(() => setNow(Date.now()), 30_000);
  onCleanup(() => clearInterval(timer));
  return (
    <section class="manager-card" aria-label="Assigned tasks">
      <h2 class="manager-card-title">
        Assigned {props.rows.length} {props.rows.length === 1 ? "task" : "tasks"}
      </h2>
      <ul class="manager-rows">
        <For each={props.rows}>
          {(row) => (
            <DelegationRowView
              row={row}
              now={now()}
              bot={botFor(props.bots, row.botId)}
              onSelectAgent={props.onSelectAgent}
            />
          )}
        </For>
      </ul>
    </section>
  );
}

function DelegationRowView(props: {
  row: DelegationRow;
  now: number;
  bot: BotProfile | undefined;
  onSelectAgent: (botId: string) => void;
}) {
  const [confirming, setConfirming] = createSignal(false);
  const [stopped, setStopped] = createSignal(false);
  const [error, setError] = createSignal("");
  const status = (): TaskStatus => (stopped() ? "cancelled" : props.row.status);
  const details = () =>
    [
      STATUS_LABELS[status()],
      props.row.reason && ACTIVE.includes(status()) ? props.row.reason : "",
      elapsed(props.row.startedAt, props.row.finishedAt, props.now),
      spend(props.row.costUsd, props.row.budgetUsd),
    ]
      .filter(Boolean)
      .join(" · ");
  async function stop() {
    setConfirming(false);
    setStopped(true);
    setError("");
    try {
      await run({ action: "stop", taskId: props.row.taskId });
    } catch (failure) {
      setStopped(false);
      setError(message(failure) || "Couldn't stop it. Try again.");
    }
  }
  return (
    <li class="manager-row">
      <AgentAvatar bot={props.bot} class="manager-avatar" />
      <div class="manager-row-text">
        <span class="manager-row-title">{props.row.title}</span>
        <span class="manager-row-meta">
          <span class={`manager-dot manager-dot-${status()}`} aria-hidden="true" />
          {props.row.owner} · {details()}
        </span>
        <Show when={error()}>
          <span class="manager-error" role="alert">
            {error()}
          </span>
        </Show>
      </div>
      <div class="manager-actions">
        <Show
          when={confirming()}
          fallback={
            <>
              <Show when={props.row.botId}>
                {(botId) => (
                  <button
                    type="button"
                    class="manager-button"
                    aria-label={`Open ${props.row.title}`}
                    onClick={() => props.onSelectAgent(botId())}
                  >
                    Open
                  </button>
                )}
              </Show>
              <Show when={ACTIVE.includes(status())}>
                <button
                  type="button"
                  class="manager-button manager-button-danger"
                  aria-label={`Stop ${props.row.title}`}
                  onClick={() => setConfirming(true)}
                >
                  Stop
                </button>
              </Show>
            </>
          }
        >
          <span class="manager-confirm-label">Stop this task?</span>
          <button
            type="button"
            class="manager-button manager-button-danger"
            ref={(element) => queueMicrotask(() => element.focus())}
            onClick={() => void stop()}
          >
            Stop task
          </button>
          <button type="button" class="manager-button" onClick={() => setConfirming(false)}>
            Keep
          </button>
        </Show>
      </div>
    </li>
  );
}

const TESTS: Record<string, string> = {
  passed: "Passed",
  failed: "Failed",
  partial: "Partly passed",
};

function ResultCardView(props: {
  card: ResultCard;
  bots: BotProfile[];
  onSelectAgent: (botId: string) => void;
}) {
  const [decided, setDecided] = createSignal<"accepted" | "sent_back" | null>(null);
  const [writing, setWriting] = createSignal(false);
  const [feedback, setFeedback] = createSignal("");
  const [error, setError] = createSignal("");
  const status = () =>
    decided() === "accepted"
      ? "Accepted"
      : decided() === "sent_back"
        ? "Sent back"
        : STATUS_LABELS[props.card.status];
  const files = () => {
    const list = props.card.files;
    if (list.length <= 3) return list.join(", ");
    return `${list.slice(0, 2).join(", ")} and ${list.length - 2} more`;
  };
  async function decide(input: TaskActionInput, outcome: "accepted" | "sent_back") {
    setDecided(outcome);
    setWriting(false);
    setError("");
    try {
      await run(input);
    } catch (failure) {
      setDecided(null);
      setError(message(failure) || "That didn't go through. Try again.");
    }
  }
  const fields = (): [string, string][] =>
    [
      ["Changed", files()] as [string, string],
      ["Tests", props.card.tests ? (TESTS[props.card.tests] ?? "") : ""] as [string, string],
      ["Cost", spend(props.card.costUsd, props.card.budgetUsd)] as [string, string],
      ["Manager's note", props.card.note ?? ""] as [string, string],
    ].filter(([, value]) => value);
  const titleId = `result-${props.card.taskId.replace(/[^A-Za-z0-9_-]/g, "-")}`;
  return (
    <section class="manager-card" aria-labelledby={titleId}>
      <div class="manager-card-head">
        <AgentAvatar bot={botFor(props.bots, props.card.botId)} class="manager-avatar" />
        <h2 class="manager-card-title" id={titleId}>
          {props.card.title}
        </h2>
        <span
          class="manager-pill"
          classList={{ "manager-pill-review": !decided() && props.card.status === "review" }}
        >
          {status()}
        </span>
      </div>
      <Show when={fields().length}>
        <dl class="manager-fields">
          <For each={fields()}>
            {([label, value]) => (
              <>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </>
            )}
          </For>
        </dl>
      </Show>
      <Show when={writing()}>
        <form
          class="manager-send-back"
          onSubmit={(event) => {
            event.preventDefault();
            const words = feedback().trim();
            if (!words) return;
            void decide(
              {
                action: "send_back",
                taskId: props.card.taskId,
                revision: props.card.revision,
                feedback: words,
              },
              "sent_back",
            );
          }}
        >
          <label for={`${titleId}-feedback`}>What should change?</label>
          <textarea
            id={`${titleId}-feedback`}
            rows={3}
            value={feedback()}
            ref={(element) => queueMicrotask(() => element.focus())}
            onInput={(event) => setFeedback(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setWriting(false);
            }}
          />
          <div class="manager-actions">
            <button
              type="submit"
              class="manager-button manager-button-primary"
              disabled={!feedback().trim()}
            >
              Send back
            </button>
            <button type="button" class="manager-button" onClick={() => setWriting(false)}>
              Cancel
            </button>
          </div>
        </form>
      </Show>
      <Show when={error()}>
        <p class="manager-error" role="alert">
          {error()}
        </p>
      </Show>
      <div class="manager-actions">
        <Show when={props.card.status === "review" && !decided() && !writing()}>
          <button
            type="button"
            class="manager-button manager-button-primary"
            onClick={() =>
              void decide(
                { action: "accept", taskId: props.card.taskId, revision: props.card.revision },
                "accepted",
              )
            }
          >
            Accept
          </button>
          <button type="button" class="manager-button" onClick={() => setWriting(true)}>
            Send back…
          </button>
        </Show>
        <Show when={props.card.botId}>
          {(botId) => (
            <button
              type="button"
              class="manager-button manager-button-quiet"
              onClick={() => props.onSelectAgent(botId())}
            >
              Open {props.card.owner}'s chat
            </button>
          )}
        </Show>
      </div>
    </section>
  );
}
