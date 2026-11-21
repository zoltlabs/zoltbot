// C7: select words in a message, then press ⌘L or click Ask about this. The words go into the
// composer as a quote, ready for a question.
import { quoteText } from "@zoltbot/protocol";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { useShortcut } from "../../app-shortcuts";
import { t } from "../../i18n";
import { floatingLayer } from "../../kit";
import "./ask-about.css";

const SETTLE_MS = 150;
const MESSAGE = ".message-shell, .exchange-message-entry";

interface Found {
  text: string;
  rect: DOMRect;
}

/** The words selected inside one or more messages of this transcript. */
export function selectedWords(root: Element | undefined): Found | undefined {
  const selection = window.getSelection();
  if (!root || !selection || selection.isCollapsed || !selection.rangeCount) return undefined;
  const range = selection.getRangeAt(0);
  const inMessage = (node: Node) => {
    const element = node instanceof Element ? node : node.parentElement;
    const message = element?.closest(MESSAGE);
    return !!message && root.contains(message) && !element?.closest("[contenteditable='true']");
  };
  if (!inMessage(range.startContainer) || !inMessage(range.endContainer)) return undefined;
  const text = selection.toString().trim();
  return text ? { text, rect: range.getBoundingClientRect() } : undefined;
}

/** The composer text with the quote added at the end, followed by a blank line. */
export function withAskQuote(draft: string, words: string): string {
  const quote = `${quoteText(words)}\n\n`;
  return draft.trim() ? `${draft.trimEnd()}\n\n${quote}` : quote;
}

/** Puts the caret at the end of the chat's composer. */
export function focusComposerEnd(): void {
  const editor = document.querySelector<HTMLElement>(".composer-editor-surface");
  if (!editor) return;
  editor.focus();
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

export function AskAboutThis(props: {
  root: () => Element | undefined;
  onAsk: (words: string) => void;
}) {
  const [found, setFound] = createSignal<Found>();
  let timer: number | undefined;
  const settle = () => {
    window.clearTimeout(timer);
    setFound(undefined);
    timer = window.setTimeout(() => setFound(selectedWords(props.root())), SETTLE_MS);
  };
  // Scrolling moves the words, so the button hides and comes back in the new place.
  onMount(() => {
    document.addEventListener("selectionchange", settle);
    document.addEventListener("scroll", settle, true);
  });
  onCleanup(() => {
    document.removeEventListener("selectionchange", settle);
    document.removeEventListener("scroll", settle, true);
    window.clearTimeout(timer);
  });
  const ask = (words: string) => {
    window.clearTimeout(timer);
    setFound(undefined);
    props.onAsk(words);
  };
  useShortcut({
    id: "chat.askAboutThis",
    keys: "Mod+L",
    // Selecting words doesn't move focus, so this listens everywhere and only acts on a
    // selection inside the transcript.
    when: "global",
    label: () => t("chat.askAbout"),
    run: () => {
      const words = selectedWords(props.root());
      if (!words) return false;
      ask(words.text);
      return undefined;
    },
  });
  return (
    <Show when={found()}>
      {(at) => (
        <Portal mount={floatingLayer(props.root())}>
          <button
            type="button"
            class="ask-about"
            style={{
              // Above the words, or below them near the top of the window.
              top: `${at().rect.top >= 48 ? at().rect.top - 40 : at().rect.bottom + 8}px`,
              left: `${Math.max(8, Math.min(at().rect.left, window.innerWidth - 160))}px`,
            }}
            aria-keyshortcuts="Meta+L"
            // Keep the selection when the button is pressed.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => ask(at().text)}
          >
            {t("chat.askAbout")}
            <span class="ask-about-keys" aria-hidden="true">
              ⌘L
            </span>
          </button>
        </Portal>
      )}
    </Show>
  );
}
