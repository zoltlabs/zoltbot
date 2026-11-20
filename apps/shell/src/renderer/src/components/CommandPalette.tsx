// The command palette (S7): ⌘K searches chats, agents, channels, tasks, pages and commands.
import { createEffect, createMemo, createSignal, For, on, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { t } from "../i18n";
import { floatingLayer, useDismiss } from "../kit/floating";
import { type PaletteItem, rankPalette, rememberRecent } from "../palette";
import "./palette.css";

const RECENT_KEY = "zoltbot.palette.recent";

function readRecent(): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(saved) ? saved.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function saveRecent(recent: string[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
  } catch {
    // Recents are a convenience; without storage the palette still works.
  }
}

const GROUP_KEYS = {
  recent: "palette.group.recent",
  chats: "palette.group.chats",
  agents: "palette.group.agents",
  channels: "palette.group.channels",
  tasks: "palette.group.tasks",
  pages: "palette.group.pages",
  commands: "palette.group.commands",
} as const;

export function CommandPalette(props: { items: () => PaletteItem[]; onClose: () => void }) {
  const [query, setQuery] = createSignal("");
  const [recent, setRecent] = createSignal(readRecent());
  const [active, setActive] = createSignal(0);
  const sections = createMemo(() => rankPalette(props.items(), query(), recent()));
  const flat = createMemo(() => sections().flatMap((section) => section.items));
  let panel: HTMLElement | undefined;
  let input: HTMLInputElement | undefined;
  const listId = "command-palette-list";
  const optionId = (index: number) => `command-palette-option-${index}`;

  // Registered before focus moves in, so focus returns to where it was when the palette closes.
  useDismiss({
    open: () => true,
    floating: () => panel,
    anchor: () => undefined,
    onDismiss: () => props.onClose(),
  });
  onMount(() => input?.focus());
  createEffect(on(query, () => setActive(0), { defer: true }));
  // The list rebuilds when chats, channels or tasks change; keep the highlight on a real row.
  createEffect(() => {
    const count = flat().length;
    if (active() >= count) setActive(Math.max(0, count - 1));
  });
  createEffect(() => {
    const index = active();
    document.getElementById(optionId(index))?.scrollIntoView?.({ block: "nearest" });
  });

  function run(item: PaletteItem) {
    const next = rememberRecent(recent(), item.id);
    setRecent(next);
    saveRecent(next);
    item.run();
    props.onClose();
    // A page or channel the item opened covers what had focus before, so focus can't go back
    // there. Move it to the new view's heading instead.
    setTimeout(() => {
      const active = document.activeElement;
      if (active && active !== document.body && !active.closest("[inert]")) return;
      const heading = [...document.querySelectorAll<HTMLElement>("main h1, h1")].find(
        (element) => !element.closest("[inert]") && element.getClientRects().length > 0,
      );
      if (!heading) return;
      if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
      heading.focus();
    });
  }

  function keydown(event: KeyboardEvent) {
    // The Enter that confirms text typed with an input method isn't a choice.
    if (event.isComposing) return;
    const count = flat().length;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!count) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((index) => (index + step + count) % count);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const item = flat()[active()];
      if (item) run(item);
    } else if (event.key === "Tab") {
      // The search field is the palette's only stop; arrows move through the results.
      event.preventDefault();
    }
  }

  return (
    <Portal mount={floatingLayer()}>
      <div
        class="zb-kit-backdrop command-palette-backdrop"
        role="presentation"
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) props.onClose();
        }}
      >
        <section
          ref={panel}
          class="command-palette"
          role="dialog"
          aria-modal="true"
          aria-label={t("palette.title")}
          data-kit-overlay="dialog"
        >
          <input
            ref={input}
            class="command-palette-input"
            type="text"
            role="combobox"
            aria-expanded={flat().length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={flat().length ? optionId(active()) : undefined}
            aria-label={t("palette.placeholder")}
            placeholder={t("palette.placeholder")}
            autocomplete="off"
            spellcheck={false}
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={keydown}
          />
          <div id={listId} class="command-palette-list" role="listbox">
            <For each={sections()}>
              {(section) => {
                const headingId = `command-palette-group-${section.group}`;
                return (
                  <div class="command-palette-group" role="group" aria-labelledby={headingId}>
                    <div id={headingId} class="command-palette-heading" role="presentation">
                      {t(GROUP_KEYS[section.group])}
                    </div>
                    <For each={section.items}>
                      {(item) => {
                        const index = () => flat().indexOf(item);
                        return (
                          // biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/useFocusableInteractive: options stay out of the tab order; the search field moves through them with aria-activedescendant.
                          <div
                            id={optionId(index())}
                            class="command-palette-option"
                            role="option"
                            aria-selected={index() === active()}
                            onPointerMove={() => setActive(index())}
                            onClick={() => run(item)}
                          >
                            <span class="command-palette-label" title={item.label}>
                              {item.label}
                            </span>
                            <Show when={item.detail}>
                              <span class="command-palette-detail">{item.detail}</span>
                            </Show>
                          </div>
                        );
                      }}
                    </For>
                  </div>
                );
              }}
            </For>
          </div>
          {/* Always mounted, so a screen reader announces when its text changes. */}
          <p class="command-palette-empty" role="status">
            {query().trim() && !flat().length ? t("palette.empty", { query: query().trim() }) : ""}
          </p>
        </section>
      </div>
    </Portal>
  );
}
