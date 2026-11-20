import { createSignal } from "solid-js";

/** Whether the transcript has more above or below, for the fades at its edges. */
export function createScrollFade() {
  const [fadeAtTop, setFadeAtTop] = createSignal(false);
  const [fadeAtBottom, setFadeAtBottom] = createSignal(false);
  return {
    fadeAtTop,
    fadeAtBottom,
    update(element: HTMLElement | undefined) {
      if (!element) return;
      const remaining = element.scrollHeight - element.scrollTop - element.clientHeight;
      setFadeAtTop(element.scrollTop > 2);
      setFadeAtBottom(remaining > 2);
    },
  };
}

/** Remembers which messages have shown, per chat, so each animates in only once. */
export function createSeenMessages(botId: () => string | undefined) {
  const seen = new Set<string>();
  return (messageId: string): boolean => {
    const key = `${botId() ?? "none"}:${messageId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
}
