// M2: Forget one passage of a memory entry. Uses text selected in the entry, or lets the owner
// pick a sentence when nothing is selected, so it works from the keyboard too.
import { createUniqueId, For, onMount } from "solid-js";
import { t } from "../i18n";

/** The entry's sentences and lines, in order. */
export function memorySentences(body: string): string[] {
  return body
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Text the owner selected inside `within`, when it is part of `body`. */
export function selectedQuote(within: HTMLElement | undefined, body: string): string | null {
  const selection = window.getSelection();
  if (!within || !selection || selection.isCollapsed || !selection.rangeCount) return null;
  if (!within.contains(selection.getRangeAt(0).commonAncestorContainer)) return null;
  const quote = selection.toString().trim();
  return quote && body.includes(quote) ? quote : null;
}

export function MemorySentencePicker(props: {
  body: string;
  busy: boolean;
  onPick: (sentence: string) => void;
  onCancel: () => void;
}) {
  const promptId = createUniqueId();
  let list: HTMLUListElement | undefined;
  // The Forget button that had focus is gone; start on the first sentence.
  onMount(() => queueMicrotask(() => list?.querySelector("button")?.focus()));
  return (
    <div class="memory-forget-pick">
      <p id={promptId} class="memory-forget-prompt">
        {t("memory.entry.forgetPick")}
      </p>
      <ul ref={list} class="memory-sentences" aria-labelledby={promptId}>
        <For each={memorySentences(props.body)}>
          {(sentence) => (
            <li>
              <button
                type="button"
                class="memory-sentence"
                disabled={props.busy}
                onClick={() => props.onPick(sentence)}
              >
                {sentence}
              </button>
            </li>
          )}
        </For>
      </ul>
      <div class="memory-actions">
        <button type="button" class="zb-kit-button" onClick={props.onCancel}>
          {t("memory.entry.cancel")}
        </button>
      </div>
    </div>
  );
}
