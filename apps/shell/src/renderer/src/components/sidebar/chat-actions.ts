// S9: pin, read state and archive from the sidebar, with Undo for archive.
import { createEffect, createSignal, on, onCleanup } from "solid-js";
import type { ThreadAction } from "../../../../shared/thread-actions";
import type { BotProfile } from "../../data";
import { t } from "../../i18n";
import { showToast } from "../../kit";

/**
 * How long Undo stays offered after archiving a chat. Longer than the plan's 5 seconds, so it can
 * be reached from the keyboard (WCAG 2.2.1); it also pauses while focused or hovered.
 */
export const ARCHIVE_UNDO_MS = 20_000;

export function createChatActions(deps: {
  bots: () => readonly BotProfile[];
  /** The chat the owner is looking at, or nothing while a page or channel covers it. */
  activeBotId: () => string | null | undefined;
  /** Clears the app's own count of replies the owner hasn't seen. */
  clearLocalUnread: (botId: string) => void;
}) {
  // A chat the owner marks unread while it's open stays unread until they leave it.
  const keptUnread = new Set<string>();
  const send = (botId: string, action: ThreadAction) =>
    window.openbot.agent.threadAction({ botId, action });
  const failed = () => showToast({ message: t("sidebar.chat.failed") });

  const [focused, setFocused] = createSignal(document.hasFocus());
  const focus = () => setFocused(true);
  const blur = () => setFocused(false);
  window.addEventListener("focus", focus);
  window.addEventListener("blur", blur);
  onCleanup(() => {
    window.removeEventListener("focus", focus);
    window.removeEventListener("blur", blur);
  });

  createEffect(
    on(deps.activeBotId, (_, previous) => {
      if (previous) keptUnread.delete(previous);
    }),
  );
  // Reading a chat marks it read, including when a reply lands while it's open.
  createEffect(
    on(
      () => {
        const id = deps.activeBotId();
        if (!id || !focused()) return undefined;
        return deps.bots().find((bot) => bot.id === id)?.unread ? id : undefined;
      },
      (id) => {
        if (id && !keptUnread.has(id)) void send(id, "markRead").catch(() => undefined);
      },
    ),
  );

  function run(bot: BotProfile, action: ThreadAction) {
    if (action === "markUnread" && bot.id === deps.activeBotId()) keptUnread.add(bot.id);
    if (action === "markRead") deps.clearLocalUnread(bot.id);
    const done = send(bot.id, action);
    // A3: say what Mute keeps, since the owner can't see it.
    if (action === "mute")
      done.then(() => showToast({ message: t("sidebar.chat.mutedNote") })).catch(failed);
    else if (action !== "archive") {
      done.catch(failed);
      return;
    }
    done
      .then(() =>
        showToast({
          message: t("sidebar.chat.archived"),
          duration: ARCHIVE_UNDO_MS,
          action: {
            label: t("sidebar.chat.undo"),
            run: () => void send(bot.id, "unarchive").catch(failed),
          },
        }),
      )
      .catch(failed);
  }

  return { run };
}
