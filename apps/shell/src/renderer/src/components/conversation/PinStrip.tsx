// C4: pinned messages, in a strip under the chat header. A pin jumps to its message; up to three
// show, and the rest open from "{n} more".
import { createEffect, createSignal, For, on, Show } from "solid-js";
import { t } from "../../i18n";
import { Menu } from "../../kit";
import { PinIcon } from "./icons";
import { currentPins, watchPins } from "./pins-store";
import "./pins.css";

const SHOWN = 3;

/** Scrolls to a message and moves focus there, so the keyboard lands on what was picked. */
export function jumpToMessage(messageId: string) {
  const target = document.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
  if (!(target instanceof HTMLElement)) return;
  const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  target.scrollIntoView({ block: "center", behavior: still ? "auto" : "smooth" });
  if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
  target.focus({ preventScroll: true });
  target.classList.add("message-entry-jumped");
  setTimeout(() => target.classList.remove("message-entry-jumped"), 1600);
}

/** One line of the message; the chip's CSS cuts it to fit and the tooltip shows the rest. */
const line = (text: string) => text.replace(/\s+/g, " ").trim();

export function PinStrip(props: { botId: string | undefined }) {
  const [more, setMore] = createSignal<HTMLElement | null>(null);
  watchPins(() => props.botId);
  createEffect(
    on(
      () => props.botId,
      () => setMore(null),
    ),
  );
  const pins = currentPins;

  return (
    <Show when={pins().length > 0}>
      <nav class="pin-strip" aria-label={t("pins.title")}>
        <span class="pin-strip-icon" aria-hidden="true">
          <PinIcon />
        </span>
        <For each={pins().slice(0, SHOWN)}>
          {(pin) => (
            <button
              type="button"
              class="pin-chip"
              title={line(pin.text)}
              onClick={() => jumpToMessage(pin.messageId)}
            >
              <span class="pin-chip-text">{line(pin.text)}</span>
            </button>
          )}
        </For>
        <Show when={pins().length > SHOWN}>
          <button
            type="button"
            class="pin-chip pin-more"
            aria-haspopup="menu"
            aria-expanded={more() !== null}
            onClick={(event) => setMore(event.currentTarget)}
          >
            {t("pins.more", { count: pins().length - SHOWN })}
          </button>
        </Show>
        <Show when={more()}>
          {(anchor) => (
            <Menu
              anchor={anchor()}
              label={t("pins.title")}
              placement="bottom-start"
              groups={[
                pins()
                  .slice(SHOWN)
                  .map((pin) => ({
                    id: pin.messageId,
                    label: line(pin.text),
                    run: () => jumpToMessage(pin.messageId),
                  })),
              ]}
              onClose={() => setMore(null)}
            />
          )}
        </Show>
      </nav>
    </Show>
  );
}
