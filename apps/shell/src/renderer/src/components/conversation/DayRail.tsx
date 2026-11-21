// C20: a thin rail on the right of a long chat, one mark per day. Hover names the
// day; a click scrolls to its first message.
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import type { BotMessage } from "../../data";
import { t } from "../../i18n";
import { Tooltip } from "../../kit";
import { currentDay, dayLabel, dayStarts, showsRail } from "./day-rail";
import "./day-rail.css";

/** Rows the transcript draws with a `data-message-id`, which the rail can scroll to. */
function anchored(message: BotMessage): boolean {
  if (message.card || message.notice || message.kind === "notice" || message.aside) return false;
  // A hidden row of any kind keeps its id; otherwise exchanges and thinking have none.
  return message.hidden === true || (!message.exchange && message.kind !== "thinking");
}

/** How far below the top edge a day's first message can sit and still count as in view. */
const TOP_SLACK = 24;
/** Matches `.day-rail` in day-rail.css. */
const RAIL_WIDTH = 24;

function rowFor(scroller: HTMLElement, messageId: string): HTMLElement | null {
  return scroller.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`);
}

export function DayRail(props: {
  messages: readonly BotMessage[];
  /** False while the transcript isn't drawn, such as with the agent picker open. */
  when: boolean;
  scroller: () => HTMLElement | undefined;
}) {
  // Keep the same days while only their contents change, so marks, focus and tooltips survive
  // each new message.
  const days = createMemo(() => dayStarts(props.messages.filter(anchored)), [], {
    equals: (a, b) =>
      a.length === b.length &&
      a.every((day, index) => day.day === b[index].day && day.firstId === b[index].firstId),
  });
  const visible = () => props.when && showsRail(days());
  const [current, setCurrent] = createSignal(0);
  const [box, setBox] = createSignal(
    { top: 0, left: 0, height: 0 },
    {
      equals: (a, b) => a.top === b.top && a.left === b.left && a.height === b.height,
    },
  );

  let frame: number | undefined;
  const measure = () => {
    frame = undefined;
    const scroller = props.scroller();
    if (!scroller) return;
    // Side panels narrow the transcript, so place the rail by the scroller's own right edge.
    setBox({
      top: scroller.offsetTop,
      left: scroller.offsetLeft + scroller.clientWidth - RAIL_WIDTH - 2,
      height: scroller.clientHeight,
    });
    const origin = scroller.getBoundingClientRect().top - scroller.scrollTop;
    const tops = days().map((day) => {
      const row = rowFor(scroller, day.firstId);
      return row ? row.getBoundingClientRect().top - origin : Number.POSITIVE_INFINITY;
    });
    // At the bottom, the newest day is the one in view even when it starts lower down.
    const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
    setCurrent(atBottom ? tops.length - 1 : currentDay(tops, scroller.scrollTop + TOP_SLACK));
  };
  const schedule = () => {
    if (frame === undefined) frame = requestAnimationFrame(measure);
  };

  // The transcript leaves room on the right while the rail shows.
  createEffect(() => {
    const scroller = props.scroller();
    if (!scroller) return;
    const shown = visible();
    scroller.classList.toggle("day-rail-room", shown);
    onCleanup(() => scroller.classList.remove("day-rail-room"));
  });

  // A new chat, new messages or the transcript appearing move the days.
  createEffect(on([days, visible], schedule, { defer: true }));

  onMount(() => {
    const scroller = props.scroller();
    if (!scroller) return;
    scroller.addEventListener("scroll", schedule, { passive: true });
    const resize = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(schedule);
    resize?.observe(scroller);
    schedule();
    onCleanup(() => {
      scroller.removeEventListener("scroll", schedule);
      resize?.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
    });
  });

  const jump = (messageId: string) => {
    const scroller = props.scroller();
    const row = scroller && rowFor(scroller, messageId);
    if (!row) return;
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    row.scrollIntoView({ block: "start", behavior: still ? "auto" : "smooth" });
    if (!row.hasAttribute("tabindex")) row.setAttribute("tabindex", "-1");
    row.focus({ preventScroll: true });
    // The same brief highlight a pin uses, so the eye finds where the jump landed.
    row.classList.add("message-entry-jumped");
    setTimeout(() => row.classList.remove("message-entry-jumped"), 1600);
  };

  return (
    <Show when={visible()}>
      <nav
        class="day-rail"
        aria-label={t("chat.dayRail.label")}
        style={{ top: `${box().top}px`, left: `${box().left}px`, height: `${box().height}px` }}
      >
        <ol>
          <For each={days()}>
            {(day, index) => {
              const label = dayLabel(day.date);
              return (
                <li>
                  <Tooltip label={label}>
                    <button
                      type="button"
                      class="day-rail-mark"
                      aria-label={label}
                      aria-current={index() === current() ? "true" : undefined}
                      onClick={() => jump(day.firstId)}
                    >
                      <span aria-hidden="true" />
                    </button>
                  </Tooltip>
                </li>
              );
            }}
          </For>
        </ol>
      </nav>
    </Show>
  );
}
