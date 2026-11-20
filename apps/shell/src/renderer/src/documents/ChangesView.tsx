import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import { describeChange, type ProseChange, proseDiff } from "../../../shared/prose-diff";

interface ChangesViewProps {
  baseline: string;
  current: string;
  /** "review" offers Accept and Reject for each change; "compare" only shows them. */
  kind: "review" | "compare";
  label: string;
  busy?: boolean;
  onAccept?: (change: ProseChange) => void;
  onReject?: (change: ProseChange) => void;
}

/**
 * Track changes: the current text with each change shown in place, removed words struck through
 * and added words underlined. One change at a time is current; the bar below moves between them
 * and accepts or rejects it. J and K move, A accepts, R rejects.
 */
export function ChangesView(props: ChangesViewProps) {
  const diff = createMemo(() => proseDiff(props.baseline, props.current));
  const [activeIndex, setActiveIndex] = createSignal(0);
  let body: HTMLDivElement | undefined;

  const changes = () => diff().changes;
  const active = () => changes()[Math.min(activeIndex(), changes().length - 1)] ?? null;

  createEffect(
    on(
      () => changes().length,
      (count) => {
        if (activeIndex() > count - 1) setActiveIndex(Math.max(0, count - 1));
      },
    ),
  );

  createEffect(
    on(active, (change) => {
      if (!change || !body) return;
      body
        .querySelector<HTMLElement>(`[data-change-id="${CSS.escape(change.id)}"]`)
        ?.scrollIntoView({ block: "nearest", behavior: "auto" });
    }),
  );

  const move = (step: number) => {
    const count = changes().length;
    if (!count) return;
    setActiveIndex((index) => (index + step + count) % count);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, select, [contenteditable='true']")) return;
    const key = event.key.toLowerCase();
    const change = active();
    if (key === "j") move(1);
    else if (key === "k") move(-1);
    else if (key === "a" && change && props.kind === "review" && !props.busy)
      props.onAccept?.(change);
    else if (key === "r" && change && props.kind === "review" && !props.busy)
      props.onReject?.(change);
    else return;
    event.preventDefault();
  };

  return (
    <section class="doc-changes" aria-label={props.label}>
      <div
        ref={body}
        role="document"
        class="doc-changes-body"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the text scrolls, so it takes focus for keyboard scrolling and J, K, A and R.
        tabIndex={0}
        aria-label={`${props.label}, text`}
        onKeyDown={onKeyDown}
        onClick={(event) => {
          const id = (event.target as HTMLElement).closest<HTMLElement>("[data-change-id]")?.dataset
            .changeId;
          const index = changes().findIndex((change) => change.id === id);
          if (index >= 0) setActiveIndex(index);
        }}
      >
        <For each={diff().segments}>
          {(segment) =>
            segment.type === "equal" ? (
              segment.text
            ) : (
              <span
                class="doc-change"
                classList={{ "doc-change-active": active()?.id === segment.change.id }}
                data-change-id={segment.change.id}
              >
                <Show when={segment.change.removed}>
                  <del>
                    <span class="sr-only">Removed: </span>
                    {segment.change.removed}
                  </del>
                </Show>
                <Show when={segment.change.added}>
                  <ins>
                    <span class="sr-only">Added: </span>
                    {segment.change.added}
                  </ins>
                </Show>
              </span>
            )
          }
        </For>
      </div>
      <div class="doc-review-bar" role="group" aria-label="Changes" onKeyDown={onKeyDown}>
        <Show when={active()} fallback={<p class="doc-review-count">No differences.</p>}>
          {(change) => (
            <>
              <p class="doc-review-count" aria-live="polite">
                <span class="doc-review-position">
                  Change {Math.min(activeIndex(), changes().length - 1) + 1} of {changes().length}
                </span>
                <span class="doc-review-summary">{describeChange(change())}</span>
              </p>
              <div class="doc-review-actions">
                <button
                  type="button"
                  class="doc-button"
                  aria-keyshortcuts="K"
                  disabled={changes().length < 2}
                  onClick={() => move(-1)}
                >
                  Previous
                </button>
                <button
                  type="button"
                  class="doc-button"
                  aria-keyshortcuts="J"
                  disabled={changes().length < 2}
                  onClick={() => move(1)}
                >
                  Next
                </button>
                <Show when={props.kind === "review"}>
                  <button
                    type="button"
                    class="doc-button"
                    aria-keyshortcuts="R"
                    disabled={props.busy}
                    onClick={() => props.onReject?.(change())}
                  >
                    Reject
                  </button>
                  <button
                    type="button"
                    class="doc-button doc-button-primary"
                    aria-keyshortcuts="A"
                    disabled={props.busy}
                    onClick={() => props.onAccept?.(change())}
                  >
                    Accept
                  </button>
                </Show>
              </div>
            </>
          )}
        </Show>
      </div>
    </section>
  );
}

export function changeCount(baseline: string | null, current: string): number {
  return baseline === null ? 0 : proseDiff(baseline, current).changes.length;
}
