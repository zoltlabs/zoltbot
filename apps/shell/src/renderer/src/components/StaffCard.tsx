import { createSignal, For, Show } from "solid-js";
import type { StaffCard as StaffCardData, StaffFieldRow } from "../../../shared/staff";
import "../manager.css";
import "../staff.css";

const errorText = (error: unknown) =>
  error instanceof Error
    ? error.message.replace(/^Error invoking remote method '[^']+': /, "")
    : "";
const LONG = 160;

/** One row of the before-and-after view. Long text scrolls inside the row. */
function Change(props: { row: StaffFieldRow; label: string }) {
  const long = () => (props.row.before?.length ?? 0) + (props.row.after?.length ?? 0) > LONG;
  const text = () => (
    <>
      <Show when={props.row.before}>
        {(before) => (
          <Show when={props.row.after} fallback={<span>{before()}</span>}>
            <del>
              <span class="sr-only">Was </span>
              {before()}
            </del>
            <span aria-hidden="true"> → </span>
          </Show>
        )}
      </Show>
      <Show when={props.row.after}>
        {(after) => (
          <ins>
            <Show when={props.row.before}>
              <span class="sr-only">Now </span>
            </Show>
            {after()}
          </ins>
        )}
      </Show>
    </>
  );
  return (
    <>
      <dt>{props.row.label}</dt>
      <dd class="staff-change">
        <Show when={long()} fallback={text()}>
          <section
            class="staff-change-long"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users scroll long text here.
            tabIndex={0}
            aria-label={`${props.label}: ${props.row.label}`}
          >
            {text()}
          </section>
        </Show>
      </dd>
    </>
  );
}

/**
 * The approval card for adding, changing or archiving an employee. Approve and Decline apply at
 * once and roll back with an error if the daemon refuses them.
 */
export function StaffCard(props: {
  card: StaffCardData;
  /** Shown outside the asking chat, such as in Needs you: names who asked and opens their chat. */
  onOpenChat?: (botId: string) => void;
}) {
  const [decided, setDecided] = createSignal<"approved" | "declined" | null>(null);
  const [grant, setGrant] = createSignal(false);
  const [error, setError] = createSignal("");
  const state = () => decided() ?? props.card.state;
  const id = `staff-${props.card.requestId.replace(/[^\w-]/g, "-")}`;
  const approveLabel = () =>
    props.card.action === "add"
      ? `Add ${props.card.name}`
      : props.card.action === "archive"
        ? "Archive"
        : "Apply";
  async function answer(approve: boolean) {
    setDecided(approve ? "approved" : "declined");
    setError("");
    try {
      await window.openbot.agent.staffAction(
        approve
          ? { action: "approve", requestId: props.card.requestId, grantAllowance: grant() }
          : { action: "decline", requestId: props.card.requestId },
      );
    } catch (failure) {
      setDecided(null);
      setError(errorText(failure) || "That didn't go through. Try again.");
    }
  }
  return (
    <section class="manager-card staff-card" aria-labelledby={`${id}-title`}>
      <div class="manager-card-head">
        <h2 class="manager-card-title" id={`${id}-title`}>
          {props.card.title}
        </h2>
        <Show when={state() !== "pending"}>
          <span class="manager-pill">{state() === "approved" ? "Approved" : "Declined"}</span>
        </Show>
      </div>
      <Show when={props.onOpenChat && props.card.requestedBy}>
        <p class="staff-card-note">Asked by {props.card.requestedBy}</p>
      </Show>
      <Show when={props.card.fields.length || props.card.moves.length}>
        <dl class="manager-fields staff-fields">
          <For each={props.card.fields}>
            {(row) => <Change row={row} label={props.card.title} />}
          </For>
          <For each={props.card.moves}>
            {(move) => (
              <>
                <dt>Queued task</dt>
                <dd>
                  {move.title} <span aria-hidden="true">→</span>
                  <span class="sr-only"> goes to </span> {move.to}
                </dd>
              </>
            )}
          </For>
        </dl>
      </Show>
      <Show when={props.card.action === "archive"}>
        <p class="staff-card-note">
          {props.card.running ? "Running work finishes first. " : ""}
          {props.card.name}'s chat stays readable.
        </p>
      </Show>
      <Show when={props.card.sharedWith}>
        <p class="staff-card-note">
          Also changes {props.card.sharedWith} other chat{props.card.sharedWith === 1 ? "" : "s"}{" "}
          with the same profile.
        </p>
      </Show>
      <Show when={state() === "pending" && props.card.allowance}>
        {(max) => (
          <label class="staff-card-check">
            <input
              type="checkbox"
              checked={grant()}
              onChange={(event) => setGrant(event.currentTarget.checked)}
            />
            <span>
              Let {props.card.requestedBy || "this manager"} add up to {max()} more like this
              without asking
            </span>
          </label>
        )}
      </Show>
      <Show when={error()}>
        <p class="manager-error" role="alert">
          {error()}
        </p>
      </Show>
      <div class="manager-actions">
        <Show when={state() === "pending"}>
          <button
            type="button"
            class="manager-button manager-button-primary"
            onClick={() => void answer(true)}
          >
            {approveLabel()}
          </button>
          <button
            type="button"
            class="manager-button manager-button-quiet"
            aria-label={`Decline: ${props.card.title}`}
            onClick={() => void answer(false)}
          >
            Decline
          </button>
        </Show>
        <Show when={props.onOpenChat}>
          {(open) => (
            <button
              type="button"
              class="manager-button manager-button-quiet"
              onClick={() => open()(props.card.botId)}
            >
              Open {props.card.requestedBy || "chat"}
            </button>
          )}
        </Show>
      </div>
    </section>
  );
}
