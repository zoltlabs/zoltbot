import {
  autoUpdate,
  computePosition,
  flip,
  offset,
  type Placement,
  shift,
  size,
  type VirtualElement,
} from "@floating-ui/dom";
import { createEffect, onCleanup } from "solid-js";

/** Where a floating element attaches: an element, or a point such as a right-click. */
export type Anchor = Element | { x: number; y: number };

export type Layer = "dropdown" | "popover" | "dialog" | "toast";

const EDGE_PADDING = 8;
const LAYER_ID = "zb-kit-layer";

const LANDMARKS =
  "main, aside, nav, header, footer, [role='main'], [role='complementary'], [role='navigation'], [role='banner'], [role='contentinfo'], [role='region'], section[aria-label], section[aria-labelledby]";

/**
 * The layer an overlay renders into. Modal dialogs and toasts use one
 * top-level layer at the end of <body>. Menus, lists, popovers and tooltips
 * pass the element they belong to and render at the end of its nearest
 * landmark, so screen readers find them in the same region. Either way they
 * are position: fixed, so no container's overflow can clip them.
 */
export function floatingLayer(owner?: Element | null): HTMLElement {
  const landmark = owner?.closest(LANDMARKS);
  if (landmark) {
    let local = [...landmark.children].find((child) => child.classList.contains("zb-kit-layer"));
    if (!local) {
      local = document.createElement("div");
      local.className = "zb-kit-layer";
      landmark.append(local);
    }
    return local as HTMLElement;
  }
  let layer = document.getElementById(LAYER_ID);
  if (!layer) {
    layer = document.createElement("div");
    layer.id = LAYER_ID;
    layer.className = "zb-kit-layer";
    document.body.append(layer);
  }
  return layer;
}

/** The element an overlay belongs to: its anchor, or what had focus for a point anchor. */
export function ownerOf(anchor: Anchor): Element | null {
  return anchor instanceof Element ? anchor : document.activeElement;
}

function toReference(anchor: Anchor): Element | VirtualElement {
  if (anchor instanceof Element) return anchor;
  const { x, y } = anchor;
  return {
    getBoundingClientRect: () =>
      ({ x, y, left: x, top: y, right: x, bottom: y, width: 0, height: 0 }) as DOMRect,
  };
}

/**
 * Keeps `floating()` next to its anchor and fully on screen: it flips to the
 * other side, shifts along the edge, and caps its height so it scrolls inside
 * itself when space runs out. It follows scroll, resize and layout changes.
 */
export function useFloatingPosition(options: {
  anchor: () => Anchor | undefined;
  floating: () => HTMLElement | undefined;
  placement?: Placement;
  gap?: number;
  matchWidth?: boolean;
}): void {
  createEffect(() => {
    const anchor = options.anchor();
    const floating = options.floating();
    if (!anchor || !floating) return;
    const reference = toReference(anchor);
    const update = () =>
      computePosition(reference, floating, {
        strategy: "fixed",
        placement: options.placement ?? "bottom-start",
        middleware: [
          offset(options.gap ?? 4),
          flip({ padding: EDGE_PADDING }),
          shift({ padding: EDGE_PADDING }),
          size({
            padding: EDGE_PADDING,
            apply({ availableHeight, rects }) {
              floating.style.maxHeight = `${Math.max(80, Math.floor(availableHeight))}px`;
              if (options.matchWidth) floating.style.minWidth = `${rects.reference.width}px`;
            },
          }),
        ],
      }).then(({ x, y, placement }) => {
        floating.style.left = `${x}px`;
        floating.style.top = `${y}px`;
        floating.dataset.placement = placement;
      });
    const stop =
      anchor instanceof Element ? autoUpdate(anchor, floating, update) : autoUpdateWindow(update);
    onCleanup(stop);
  });
}

function autoUpdateWindow(update: () => void): () => void {
  update();
  window.addEventListener("resize", update);
  return () => window.removeEventListener("resize", update);
}

interface OpenOverlay {
  floating: () => HTMLElement | undefined;
}

/** Open dismissable overlays, oldest first. */
const openStack: OpenOverlay[] = [];

/**
 * Closes on Escape and on a press outside the floating element and its
 * anchor, then returns focus to the element that had it when it opened.
 */
export function useDismiss(options: {
  open: () => boolean;
  floating: () => HTMLElement | undefined;
  anchor: () => Anchor | undefined;
  onDismiss: () => void;
  /** Whether a press outside closes it. Modal dialogs decide this themselves. */
  outside?: boolean;
}): void {
  createEffect(() => {
    if (!options.open()) return;
    // Focus goes back to the trigger; for a point anchor, to whatever had focus.
    const anchor = options.anchor();
    const returnTo =
      anchor instanceof HTMLElement
        ? anchor
        : document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
    const token: OpenOverlay = { floating: options.floating };
    openStack.push(token);
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // Only the newest open overlay answers Escape.
      if (openStack.at(-1) !== token) return;
      event.preventDefault();
      event.stopPropagation();
      options.onDismiss();
    };
    const pointerdown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      const floating = options.floating();
      const anchor = options.anchor();
      if (!target || floating?.contains(target)) return;
      if (anchor instanceof Element && anchor.contains(target)) return;
      // A press inside an overlay opened after this one (a submenu, or a dialog it opened)
      // is not outside. Open order decides, not where the layers sit in the document.
      const newer = openStack.slice(openStack.indexOf(token) + 1);
      if (newer.some((overlay) => overlay.floating()?.contains(target))) return;
      options.onDismiss();
    };
    document.addEventListener("keydown", keydown, true);
    if (options.outside !== false) document.addEventListener("pointerdown", pointerdown, true);
    onCleanup(() => {
      openStack.splice(openStack.indexOf(token), 1);
      document.removeEventListener("keydown", keydown, true);
      document.removeEventListener("pointerdown", pointerdown, true);
      // Return focus only if it would otherwise be lost, not if the user moved it on purpose.
      queueMicrotask(() => {
        const active = document.activeElement;
        const floating = options.floating();
        const lost = !active || active === document.body || (floating?.contains(active) ?? false);
        if (lost && returnTo?.isConnected) returnTo.focus();
      });
    });
  });
}

/** Moves focus to an element anchor right away, before the overlay closes. */
export function returnFocus(anchor: Anchor | undefined): void {
  if (anchor instanceof HTMLElement && anchor.isConnected) anchor.focus();
}

/** The text type-ahead matches: the row's label, without its check mark or shortcut. */
function itemLabel(item: HTMLElement): string {
  return (item.dataset.label ?? item.textContent ?? "").trim().toLowerCase();
}

/** Moves focus between `items` with the arrow keys, Home, End and type-ahead. */
export function rovingKeydown(
  event: KeyboardEvent,
  items: HTMLElement[],
  options: { wrap?: boolean; typeahead?: { buffer: string; at: number } } = {},
): boolean {
  if (items.length === 0) return false;
  const current = items.indexOf(document.activeElement as HTMLElement);
  const last = items.length - 1;
  const wrap = options.wrap ?? true;
  let next: number | undefined;
  if (event.key === "ArrowDown")
    next = current < 0 ? 0 : current === last ? (wrap ? 0 : last) : current + 1;
  else if (event.key === "ArrowUp")
    next = current < 0 ? last : current === 0 ? (wrap ? last : 0) : current - 1;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = last;
  else if (options.typeahead && event.key.length === 1 && !event.metaKey && !event.ctrlKey) {
    const state = options.typeahead;
    const now = Date.now();
    state.buffer = now - state.at > 600 ? event.key : state.buffer + event.key;
    state.at = now;
    const query = state.buffer.toLowerCase();
    const order = [...items.slice(current + 1), ...items.slice(0, current + 1)];
    const match =
      order.find((item) => itemLabel(item).startsWith(query)) ??
      (query.length > 1
        ? undefined
        : order.find((item) => itemLabel(item).startsWith(event.key.toLowerCase())));
    if (match) next = items.indexOf(match);
  }
  if (next === undefined) return false;
  event.preventDefault();
  items[next]?.focus();
  return true;
}
