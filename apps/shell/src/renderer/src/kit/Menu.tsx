import { For, type JSX, onMount, Show } from "solid-js";
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
  /** Set for items that toggle or pick one of several; shows a check when true. */
  checked?: boolean;
  danger?: boolean;
  disabled?: boolean;
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

  useFloatingPosition({ anchor: () => props.anchor, floating: () => element });
  useDismiss({
    open: () => true,
    anchor: () => props.anchor,
    floating: () => element,
    onDismiss: () => props.onClose(),
  });
  onMount(() => (items()[0] ?? element)?.focus());

  const choose = (item: MenuItem) => {
    if (item.disabled) return;
    // Hand focus back first, so a dialog the item opens remembers the trigger, not the menu.
    returnFocus(props.anchor);
    props.onClose();
    item.run();
  };

  return (
    <Portal mount={floatingLayer(ownerOf(props.anchor))}>
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
        onContextMenu={(event) => event.preventDefault()}
      >
        <For each={groups()}>
          {(group, index) => (
            <>
              <Show when={index() > 0}>
                <hr class="zb-kit-separator" />
              </Show>
              <For each={group}>
                {(item) => (
                  // biome-ignore lint/a11y/useAriaPropsSupportedByRole: the role is menuitemcheckbox whenever aria-checked is set.
                  <button
                    type="button"
                    class="zb-kit-menu-item"
                    classList={{ danger: item.danger }}
                    role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
                    aria-checked={item.checked === undefined ? undefined : item.checked}
                    aria-disabled={item.disabled || undefined}
                    tabIndex={-1}
                    data-item-id={item.id}
                    data-label={item.label}
                    onClick={() => choose(item)}
                    onPointerMove={(event) => {
                      if (!item.disabled) event.currentTarget.focus();
                    }}
                  >
                    <Show when={item.checked !== undefined}>
                      <span class="zb-kit-check" aria-hidden="true">
                        {item.checked ? "✓" : ""}
                      </span>
                    </Show>
                    <Show when={item.icon}>
                      <span class="zb-kit-menu-icon" aria-hidden="true">
                        {item.icon}
                      </span>
                    </Show>
                    <span class="zb-kit-menu-label">{item.label}</span>
                    <Show when={item.shortcut}>
                      <kbd class="zb-kit-shortcut">{item.shortcut}</kbd>
                    </Show>
                  </button>
                )}
              </For>
            </>
          )}
        </For>
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
  children: JSX.Element;
}

/** A non-modal panel attached to a control, for content that isn't a list of actions. */
export function Popover(props: PopoverProps) {
  let element: HTMLDivElement | undefined;
  useFloatingPosition({ anchor: () => props.anchor, floating: () => element });
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
        style={props.width ? { width: `${props.width}px` } : undefined}
      >
        {props.children}
      </div>
    </Portal>
  );
}
