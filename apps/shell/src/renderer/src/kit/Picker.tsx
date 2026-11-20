import { createMemo, createSignal, createUniqueId, For, type JSX, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import {
  floatingLayer,
  returnFocus,
  rovingKeydown,
  useDismiss,
  useFloatingPosition,
} from "./floating";

export interface PickerOption<T extends string = string> {
  value: T;
  label: string;
  /** Called each time it renders, so the trigger and the list each get their own node. */
  icon?: () => JSX.Element;
  /** Options with the same group are listed together under its name. */
  group?: string;
  /** A short value after the label, such as "default". Not a description. */
  detail?: string;
  /** Shown but not choosable, for example a model whose provider needs sign-in. */
  disabled?: boolean;
}

interface PickerProps<T extends string> {
  /** What is being picked, for example "Model". Part of the trigger's accessible name. */
  label: string;
  value: T | null;
  options: readonly PickerOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  /** Shown in the trigger when nothing is picked. */
  placeholder?: string;
  /** Id of text that states a limit or error about this choice. Not for captions. */
  describedBy?: string;
  class?: string;
}

function Chevron() {
  return (
    <svg class="zb-kit-chevron" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path d="m3 4.5 3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.4" />
    </svg>
  );
}

function Trigger<T extends string>(props: {
  picker: PickerProps<T>;
  open: boolean;
  popup: "listbox" | "dialog";
  ref: (element: HTMLButtonElement) => void;
  onOpen: () => void;
}) {
  const selected = () => props.picker.options.find((option) => option.value === props.picker.value);
  const text = () => selected()?.label ?? props.picker.placeholder ?? "";
  return (
    <button
      ref={props.ref}
      type="button"
      class={`zb-kit-trigger ${props.picker.class ?? ""}`}
      aria-haspopup={props.popup}
      aria-expanded={props.open}
      aria-label={`${props.picker.label}: ${text()}`}
      aria-describedby={props.picker.describedBy}
      disabled={props.picker.disabled}
      onClick={() => props.onOpen()}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          props.onOpen();
        }
      }}
    >
      <Show when={selected()?.icon}>
        <span class="zb-kit-option-icon">{selected()?.icon?.()}</span>
      </Show>
      <span class="zb-kit-trigger-text">{text()}</span>
      <Chevron />
    </button>
  );
}

function groupOptions<T extends string>(options: readonly PickerOption<T>[]) {
  const groups: { name: string | undefined; options: PickerOption<T>[] }[] = [];
  for (const option of options) {
    const last = groups.at(-1);
    if (last && last.name === option.group) last.options.push(option);
    else groups.push({ name: option.group, options: [option] });
  }
  return groups;
}

/** Picks one value from a short list. Never a native select, so it can't be clipped. */
export function Select<T extends string>(props: PickerProps<T>) {
  const [open, setOpen] = createSignal(false);
  let trigger: HTMLButtonElement | undefined;
  return (
    <>
      <Trigger
        picker={props}
        open={open()}
        popup="listbox"
        ref={(element) => {
          trigger = element;
        }}
        onOpen={() => setOpen(true)}
      />
      <Show when={open() && trigger}>
        {(anchor) => <SelectList anchor={anchor()} picker={props} onClose={() => setOpen(false)} />}
      </Show>
    </>
  );
}

function SelectList<T extends string>(props: {
  anchor: HTMLElement;
  picker: PickerProps<T>;
  onClose: () => void;
}) {
  let element: HTMLDivElement | undefined;
  const typeahead = { buffer: "", at: 0 };
  const items = () =>
    element
      ? [...element.querySelectorAll<HTMLElement>("[role='option']:not([aria-disabled='true'])")]
      : [];
  useFloatingPosition({ anchor: () => props.anchor, floating: () => element, matchWidth: true });
  useDismiss({
    open: () => true,
    anchor: () => props.anchor,
    floating: () => element,
    onDismiss: () => props.onClose(),
  });
  onMount(() => {
    const current = element?.querySelector<HTMLElement>("[aria-selected='true']");
    (current ?? items()[0])?.focus();
  });
  const choose = (option: PickerOption<T>) => {
    if (option.disabled) return;
    returnFocus(props.anchor);
    props.onClose();
    props.picker.onChange(option.value);
  };
  return (
    <Portal mount={floatingLayer(props.anchor)}>
      <div
        ref={element}
        class="zb-kit-floating zb-kit-listbox"
        role="listbox"
        aria-label={props.picker.label}
        data-kit-overlay="select"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Tab") {
            event.preventDefault();
            props.onClose();
          } else rovingKeydown(event, items(), { typeahead });
        }}
      >
        <For each={groupOptions(props.picker.options)}>
          {(group) => (
            <div role="group" aria-label={group.name}>
              <Show when={group.name}>
                <div class="zb-kit-group-label" aria-hidden="true">
                  {group.name}
                </div>
              </Show>
              <For each={group.options}>
                {(option) => (
                  <OptionRow
                    option={option}
                    selected={option.value === props.picker.value}
                    onChoose={() => choose(option)}
                    focusable
                  />
                )}
              </For>
            </div>
          )}
        </For>
      </div>
    </Portal>
  );
}

function OptionRow<T extends string>(props: {
  option: PickerOption<T>;
  selected: boolean;
  active?: boolean;
  id?: string;
  focusable?: boolean;
  onChoose: () => void;
  onHover?: () => void;
}) {
  return (
    <div
      id={props.id}
      role="option"
      class="zb-kit-option"
      data-label={props.option.label}
      classList={{ active: props.active }}
      aria-selected={props.selected}
      aria-disabled={props.option.disabled || undefined}
      tabIndex={props.focusable ? -1 : undefined}
      onClick={() => props.onChoose()}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          props.onChoose();
        }
      }}
      onPointerMove={(event) => {
        if (props.option.disabled) return;
        if (props.focusable) event.currentTarget.focus();
        props.onHover?.();
      }}
    >
      <span class="zb-kit-check" aria-hidden="true">
        {props.selected ? "✓" : ""}
      </span>
      <Show when={props.option.icon}>
        <span class="zb-kit-option-icon" aria-hidden="true">
          {props.option.icon?.()}
        </span>
      </Show>
      <span class="zb-kit-option-label">{props.option.label}</span>
      <Show when={props.option.detail}>
        <span class="zb-kit-option-detail">{props.option.detail}</span>
      </Show>
    </div>
  );
}

export interface ComboboxProps<T extends string> extends PickerProps<T> {
  /** Names the search field, for example "Search models". */
  searchLabel: string;
  /** Shown when nothing matches, for example "No models match". */
  emptyLabel: string;
}

/** Picks one value from a long list with search, such as the model or agent picker. */
export function Combobox<T extends string>(props: ComboboxProps<T>) {
  const [open, setOpen] = createSignal(false);
  let trigger: HTMLButtonElement | undefined;
  return (
    <>
      <Trigger
        picker={props}
        open={open()}
        popup="dialog"
        ref={(element) => {
          trigger = element;
        }}
        onOpen={() => setOpen(true)}
      />
      <Show when={open() && trigger}>
        {(anchor) => (
          <ComboboxPanel anchor={anchor()} picker={props} onClose={() => setOpen(false)} />
        )}
      </Show>
    </>
  );
}

function ComboboxPanel<T extends string>(props: {
  anchor: HTMLElement;
  picker: ComboboxProps<T>;
  onClose: () => void;
}) {
  let element: HTMLDivElement | undefined;
  let input: HTMLInputElement | undefined;
  const listId = createUniqueId();
  const [query, setQuery] = createSignal("");
  const matches = createMemo(() => {
    const words = query().trim().toLowerCase().split(/\s+/).filter(Boolean);
    return props.picker.options.filter((option) => {
      const text = `${option.label} ${option.group ?? ""}`.toLowerCase();
      return words.every((word) => text.includes(word));
    });
  });
  const [active, setActive] = createSignal(0);
  /** Options the arrow keys move through: the matches that can be chosen. */
  const choosable = createMemo(() => matches().filter((option) => !option.disabled));
  const activeOption = () => choosable()[Math.min(active(), choosable().length - 1)];
  const optionId = (option: PickerOption<T>) =>
    `${listId}-${option.value.replace(/[^A-Za-z0-9_-]/g, (char) => `_${char.charCodeAt(0)}`)}`;

  useFloatingPosition({ anchor: () => props.anchor, floating: () => element, matchWidth: true });
  useDismiss({
    open: () => true,
    anchor: () => props.anchor,
    floating: () => element,
    onDismiss: () => props.onClose(),
  });
  onMount(() => {
    const index = choosable().findIndex((option) => option.value === props.picker.value);
    setActive(Math.max(0, index));
    input?.focus();
  });

  const choose = (option: PickerOption<T> | undefined) => {
    if (!option || option.disabled) return;
    returnFocus(props.anchor);
    props.onClose();
    props.picker.onChange(option.value);
  };
  const scrollActive = () =>
    queueMicrotask(() => {
      const option = activeOption();
      if (option) document.getElementById(optionId(option))?.scrollIntoView?.({ block: "nearest" });
    });

  return (
    <Portal mount={floatingLayer(props.anchor)}>
      <div
        ref={element}
        class="zb-kit-floating zb-kit-combobox"
        role="dialog"
        aria-label={props.picker.label}
        data-kit-overlay="combobox"
      >
        <div class="zb-kit-search">
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.5" />
            <path d="m10.5 10.5 3 3" stroke="currentColor" stroke-width="1.5" />
          </svg>
          <input
            ref={input}
            role="combobox"
            aria-label={props.picker.searchLabel}
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={
              activeOption() ? optionId(activeOption() as PickerOption<T>) : undefined
            }
            value={query()}
            onInput={(event) => {
              setQuery(event.currentTarget.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              const count = choosable().length;
              if (event.key === "ArrowDown" && count > 0) {
                event.preventDefault();
                setActive((active() + 1) % count);
                scrollActive();
              } else if (event.key === "ArrowUp" && count > 0) {
                event.preventDefault();
                setActive((active() - 1 + count) % count);
                scrollActive();
              } else if (event.key === "Enter") {
                event.preventDefault();
                choose(activeOption());
              } else if (event.key === "Tab") {
                event.preventDefault();
                props.onClose();
              }
            }}
          />
        </div>
        <div
          id={listId}
          class="zb-kit-combobox-list"
          role="listbox"
          aria-label={props.picker.label}
        >
          <For each={groupOptions(matches())}>
            {(group) => (
              <div role="group" aria-label={group.name}>
                <Show when={group.name}>
                  <div class="zb-kit-group-label" aria-hidden="true">
                    {group.name}
                  </div>
                </Show>
                <For each={group.options}>
                  {(option) => (
                    <OptionRow
                      id={optionId(option)}
                      option={option}
                      selected={option.value === props.picker.value}
                      active={option === activeOption()}
                      onChoose={() => choose(option)}
                      onHover={() => setActive(choosable().indexOf(option))}
                    />
                  )}
                </For>
              </div>
            )}
          </For>
        </div>
        <Show when={matches().length === 0}>
          <div class="zb-kit-empty-row" role="status">
            {props.picker.emptyLabel}
          </div>
        </Show>
      </div>
    </Portal>
  );
}
