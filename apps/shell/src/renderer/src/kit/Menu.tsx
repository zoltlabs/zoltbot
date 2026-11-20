import type { Placement } from "@floating-ui/dom";
import { Index, type JSX, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import {
  type Anchor,
  floatingLayer,
  ownerOf,
  returnFocus,
  rovingKeydown,
  useDismiss,
  useFloatingPosition,
} from "./floating";

export interface MenuItem {
  id: string;
  label: string;
  icon?: JSX.Element;
  /** Keys shown at the end of the row, such as "⌘⇧A". */
  shortcut?: string;
  /** A value shown at the end of the row, such as "42%" or a version. Not a description. */
  detail?: string;
  /** Set for items that toggle or pick one of several; shows a check when true. */
  checked?: boolean;
  danger?: boolean;
  disabled?: boolean;
  /** Keeps the menu open after running, for actions that show their progress in the item. */
  keepOpen?: boolean;
  run: () => void;
}

export interface MenuProps {
  /** The element that opened the menu, or the point of a right-click. */
  anchor: Anchor;
  /** Names the menu for screen readers, for example "Message actions". */
  label: string;
  /** Items in groups; a separator is drawn between groups. Empty groups are skipped. */
  groups: readonly (readonly MenuItem[])[];
  onClose: () => void;
  /** Content above the items that isn't an action, such as who is signed in. */
  header?: JSX.Element;
  /** Content below the items, such as an error from the last action. */
  footer?: JSX.Element;
  /** Which side of the anchor it opens on. Flips when there isn't room. */
  placement?: Placement;
  /**
   * The element the menu belongs to when it opens at a point, such as the row that was
   * right-clicked. It renders in that element's landmark and returns focus to it.
   */
  owner?: HTMLElement;
}

/**
 * A menu of actions. It renders in the top-level layer, stays fully on
 * screen, and supports the arrow keys, Home, End and type-ahead. Choosing an
 * item closes the menu before the item runs.
 */
export function Menu(props: MenuProps) {
  let element: HTMLDivElement | undefined;
  const typeahead = { buffer: "", at: 0 };
  const groups = () => props.groups.filter((group) => group.length > 0);
  const items = () =>
    element
      ? [...element.querySelectorAll<HTMLElement>("[role^='menuitem']:not([aria-disabled='true'])")]
      : [];

  useFloatingPosition({
    anchor: () => props.anchor,
    floating: () => element,
    placement: props.placement,
  });
  useDismiss({
    open: () => true,
    anchor: () => props.anchor,
    floating: () => element,
    onDismiss: () => props.onClose(),
    returnTo: () => props.owner,
  });
  onMount(() => (items()[0] ?? element)?.focus());

  const choose = (item: MenuItem) => {
    if (item.disabled) return;
    if (item.keepOpen) {
      item.run();
      return;
    }
    // Hand focus back first, so a dialog the item opens remembers the trigger, not the menu.
    returnFocus(props.owner ?? props.anchor);
    props.onClose();
    item.run();
  };

  return (
    <Portal mount={floatingLayer(props.owner ?? ownerOf(props.anchor))}>
      <div
        ref={element}
        class="zb-kit-floating zb-kit-menu"
        role="menu"
        aria-label={props.label}
        data-kit-overlay="menu"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Tab") {
            event.preventDefault();
            props.onClose();
            return;
          }
          rovingKeydown(event, items(), { typeahead });
        }}
        onContextMenu={(event) => {
          // Keep a right-click inside the menu from reaching the row that opened it.
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <Show when={props.header}>
          <div class="zb-kit-menu-header">{props.header}</div>
          <hr class="zb-kit-separator" />
        </Show>
        <Index each={groups()}>
          {(group, index) => (
            <>
              <Show when={index > 0}>
                <hr class="zb-kit-separator" />
              </Show>
              <Index each={group()}>
                {(item) => (
                  // biome-ignore lint/a11y/useAriaPropsSupportedByRole: the role is menuitemcheckbox whenever aria-checked is set.
                  <button
                    type="button"
                    class="zb-kit-menu-item"
                    classList={{ danger: item().danger }}
                    role={item().checked === undefined ? "menuitem" : "menuitemcheckbox"}
                    aria-checked={item().checked === undefined ? undefined : item().checked}
                    aria-disabled={item().disabled || undefined}
                    tabIndex={-1}
                    data-item-id={item().id}
                    data-label={item().label}
                    onClick={() => choose(item())}
                    onPointerMove={(event) => {
                      if (!item().disabled) event.currentTarget.focus();
                    }}
                  >
                    <Show when={item().checked !== undefined}>
                      <span class="zb-kit-check" aria-hidden="true">
                        {item().checked ? "✓" : ""}
                      </span>
                    </Show>
                    <Show when={item().icon}>
                      <span class="zb-kit-menu-icon" aria-hidden="true">
                        {item().icon}
                      </span>
                    </Show>
                    <span class="zb-kit-menu-label">{item().label}</span>
                    <Show when={item().detail}>
                      <span class="zb-kit-menu-detail">{item().detail}</span>
                    </Show>
                    <Show when={item().shortcut}>
                      <kbd class="zb-kit-shortcut">{item().shortcut}</kbd>
                    </Show>
                  </button>
                )}
              </Index>
            </>
          )}
        </Index>
        <Show when={props.footer}>
          <div class="zb-kit-menu-footer">{props.footer}</div>
        </Show>
      </div>
    </Portal>
  );
}

export interface PopoverProps {
  anchor: Anchor;
  /** Names the popover for screen readers. */
  label: string;
  onClose: () => void;
  /** Width in pixels. Height follows the content and scrolls when space runs out. */
  width?: number;
  /** Which side of the anchor it opens on. Flips when there isn't room. */
  placement?: Placement;
  children: JSX.Element;
}

/** A non-modal panel attached to a control, for content that isn't a list of actions. */
export function Popover(props: PopoverProps) {
  let element: HTMLDivElement | undefined;
  useFloatingPosition({
    anchor: () => props.anchor,
    floating: () => element,
    placement: props.placement,
  });
  useDismiss({
    open: () => true,
    anchor: () => props.anchor,
    floating: () => element,
    onDismiss: () => props.onClose(),
  });
  onMount(() => {
    const first = element?.querySelector<HTMLElement>(
      "input, textarea, select, button, [href], [tabindex]:not([tabindex='-1'])",
    );
    (first ?? element)?.focus();
  });
  return (
    <Portal mount={floatingLayer(ownerOf(props.anchor))}>
      <div
        ref={element}
        class="zb-kit-floating zb-kit-popover"
        role="dialog"
        aria-label={props.label}
        data-kit-overlay="popover"
        tabIndex={-1}
        onContextMenu={(event) => event.stopPropagation()}
        style={props.width ? { width: `${props.width}px` } : undefined}
      >
        {props.children}
      </div>
    </Portal>
  );
}

export interface SuggestionsProps {
  /** The text field the list belongs to. It keeps focus while the list is open. */
  anchor: HTMLElement;
  placement?: Placement;
  /** Makes the list at least as wide as the field. */
  matchWidth?: boolean;
  /** The list itself, with role="listbox"; the field points at it with aria-activedescendant. */
  children: JSX.Element;
}

/**
 * Suggestions that float next to a text field while you type, such as @-mentions or an agent
 * search. Positioned like every kit overlay; the field handles the keys and closing.
 */
export function Suggestions(props: SuggestionsProps) {
  let element: HTMLDivElement | undefined;
  useFloatingPosition({
    anchor: () => props.anchor,
    floating: () => element,
    placement: props.placement,
    matchWidth: props.matchWidth,
  });
  return (
    <Portal mount={floatingLayer(props.anchor)}>
      <div ref={element} class="zb-kit-floating zb-kit-suggestions" data-kit-overlay="suggestions">
        {props.children}
      </div>
    </Portal>
  );
}
