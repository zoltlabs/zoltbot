// C2: the composer's Ask aside mode. While the agent works, the toggle or ⌥Enter sends the
// message as a side question instead of queueing it.
import { createEffect, createSignal, on } from "solid-js";
import { t } from "../../i18n";

export function createAsideMode(source: {
  botId: () => string | undefined;
  working: () => boolean;
  text: () => string;
  hasAttachments: () => boolean;
  clear: () => void;
}) {
  const [active, setActive] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [announcement, setAnnouncement] = createSignal("");
  // The mode ends with the turn; the next message goes to the agent as usual.
  createEffect(
    on(source.working, (working) => {
      if (!working) setActive(false);
    }),
  );
  // Each chat starts without the mode or an old error.
  createEffect(
    on(
      source.botId,
      () => {
        setActive(false);
        setError(null);
      },
      { defer: true },
    ),
  );
  /** Whether this submit is a side question: asked with ⌥Enter or with the toggle on. */
  const wanted = (options?: { aside: boolean }) =>
    options?.aside === true || (source.working() && active());
  async function ask() {
    const botId = source.botId();
    const text = source.text().trim();
    if (!botId || !text || busy()) return;
    // ⌥Enter after the turn ended: say so rather than send it to the agent as a message.
    if (!source.working()) {
      setError(t("aside.notWorking"));
      return;
    }
    // Never fall back to sending it to the agent: the owner meant a side question.
    if (source.hasAttachments()) {
      setError(t("aside.noAttachments"));
      return;
    }
    setBusy(true);
    setError(null);
    setAnnouncement("");
    try {
      await window.openbot.aside.ask({ botId, text });
      if (source.botId() === botId) source.clear();
      setAnnouncement(t("aside.asked"));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }
  return {
    active,
    toggle: () => setActive((value) => !value),
    error,
    busy,
    announcement,
    wanted,
    ask,
  };
}
