import { createEffect, createSignal, createUniqueId, type JSX, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { floatingLayer, useFloatingPosition } from "./floating";

const SHOW_DELAY_MS = 500;

/**
 * A short label shown on hover or keyboard focus after a delay. Use it to name
 * an icon-only control; never put information there that exists nowhere else.
 * The wrapped control keeps its own accessible name; the tooltip only describes it.
 */
export function Tooltip(props: { label: string; children: JSX.Element }) {
  const id = createUniqueId();
  const [open, setOpen] = createSignal(false);
  let anchor: HTMLSpanElement | undefined;
  let floating: HTMLDivElement | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const show = (delay: number) => {
    clearTimeout(timer);
    timer = setTimeout(() => setOpen(true), delay);
  };
  const hide = () => {
    clearTimeout(timer);
    setOpen(false);
  };
  onCleanup(() => clearTimeout(timer));
  // Screen readers read aria-describedby on the focused element, so set it on the control.
  createEffect(() => {
    const control = anchor?.firstElementChild;
    if (!control) return;
    const ids = (control.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);
    const rest = ids.filter((value) => value !== id);
    const next = open() ? [...rest, id] : rest;
    if (next.length) control.setAttribute("aria-describedby", next.join(" "));
    else control.removeAttribute("aria-describedby");
  });
  useFloatingPosition({
    anchor: () => (open() ? anchor : undefined),
    floating: () => floating,
    placement: "top",
    gap: 6,
  });

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: events bubble from the wrapped control.
    <span
      ref={anchor}
      class="zb-kit-tooltip-anchor"
      onPointerEnter={() => show(SHOW_DELAY_MS)}
      onPointerLeave={hide}
      onFocusIn={(event) => {
        if ((event.target as HTMLElement).matches(":focus-visible")) show(0);
      }}
      onFocusOut={hide}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open()) {
          event.stopPropagation();
          hide();
        }
      }}
      onPointerDown={hide}
    >
      {props.children}
      <Show when={open()}>
        <Portal mount={floatingLayer(anchor)}>
          <div ref={floating} id={id} role="tooltip" class="zb-kit-floating zb-kit-tooltip">
            {props.label}
          </div>
        </Portal>
      </Show>
    </span>
  );
}
