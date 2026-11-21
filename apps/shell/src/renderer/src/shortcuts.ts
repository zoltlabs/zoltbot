// One table for every keyboard shortcut. A single keydown listener dispatches
// to the most specific matching context. The command palette and the
// Keyboard shortcuts page read the same table.

export type ShortcutContext = "global" | "chat" | "composer" | "editor" | "overlay";

export interface Shortcut {
  id: string;
  /** For example "Mod+Shift+T". Mod is ⌘ on the Mac and Ctrl elsewhere. */
  keys: string;
  when: ShortcutContext;
  /** A function when the label is interface text, so it follows the language (D9). */
  label: string | (() => string);
  /** Return false to let the event continue to the next match. */
  run: (event: KeyboardEvent) => undefined | boolean;
}

/** Most specific first. */
const SPECIFICITY: readonly ShortcutContext[] = ["overlay", "editor", "composer", "chat", "global"];

/** Keys that features in the plan already own. New shortcuts must not take them. */
export const RESERVED_KEYS: Readonly<Record<string, string>> = {
  "Mod+T": "Tasks",
  "Mod+K": "Command palette",
  "Mod+L": "Quote selected text",
  "Mod+[": "Back",
  "Mod+]": "Forward",
  "Mod+.": "Stop all",
  "Mod+J": "Writing mode: today's note",
  "Mod+P": "Writing mode: quick open",
  "Mod+Shift+D": "Writing mode: chats and docs",
  "Alt+Space": "Writing mode: capture",
  "Mod+Shift+V": "Voice call",
};

interface Combo {
  key: string;
  mod: boolean;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
}

export function parseKeys(keys: string): Combo {
  const parts = keys.split("+");
  // "Mod++" would mean the plus key; no shortcut uses it, so treat "+" as a separator only.
  const key = parts.pop() ?? "";
  if (!key) throw new Error(`Shortcut keys need a key: ${keys}`);
  const combo: Combo = {
    key: key.toLowerCase(),
    mod: false,
    shift: false,
    alt: false,
    ctrl: false,
  };
  for (const part of parts) {
    if (part === "Mod") combo.mod = true;
    else if (part === "Shift") combo.shift = true;
    else if (part === "Alt") combo.alt = true;
    else if (part === "Ctrl") combo.ctrl = true;
    else throw new Error(`Unknown modifier "${part}" in ${keys}`);
  }
  return combo;
}

/** Writes keys in one canonical order so two spellings of a combination compare equal. */
export function normalizeKeys(keys: string): string {
  const combo = parseKeys(keys);
  const names = [
    combo.mod && "Mod",
    combo.ctrl && "Ctrl",
    combo.alt && "Alt",
    combo.shift && "Shift",
  ].filter(Boolean);
  const key = combo.key.length === 1 ? combo.key.toUpperCase() : capitalize(combo.key);
  return [...names, key].join("+");
}

export function matchesKeys(event: KeyboardEvent, keys: string, isMac: boolean): boolean {
  const combo = parseKeys(keys);
  const meta = isMac ? combo.mod : false;
  const ctrl = isMac ? combo.ctrl : combo.mod || combo.ctrl;
  return (
    eventKey(event) === combo.key &&
    event.metaKey === meta &&
    event.ctrlKey === ctrl &&
    event.shiftKey === combo.shift &&
    event.altKey === combo.alt
  );
}

/** Contexts that apply to an event target, most specific first, always ending in global. */
export function contextsFor(target: EventTarget | null): ShortcutContext[] {
  const found = new Set<ShortcutContext>();
  let node = target instanceof Element ? target : null;
  for (; node; node = node.parentElement) {
    const role = node.getAttribute("role");
    if (role === "dialog" || role === "alertdialog" || role === "menu" || role === "listbox")
      found.add("overlay");
    const marked = node.getAttribute("data-shortcut-context");
    if (marked === "editor" || marked === "composer" || marked === "chat") found.add(marked);
  }
  found.add("global");
  return SPECIFICITY.filter((context) => found.has(context));
}

export interface ShortcutRegistry {
  register: (shortcut: Shortcut) => () => void;
  /** Owner rebinds from preferences (F6): shortcut id → keys. */
  setBindings: (bindings: Readonly<Record<string, string>>) => void;
  keysFor: (id: string) => string | undefined;
  /** Each shortcut with the keys it answers to now and the keys it shipped with. */
  list: () => readonly (Shortcut & { keys: string; defaultKeys: string; label: string })[];
  handle: (event: KeyboardEvent) => boolean;
}

export function createShortcutRegistry(options: { isMac: boolean }): ShortcutRegistry {
  const shortcuts = new Map<string, Shortcut>();
  let bindings: Readonly<Record<string, string>> = {};

  const keysFor = (id: string) => {
    const shortcut = shortcuts.get(id);
    return shortcut ? (bindings[id] ?? shortcut.keys) : undefined;
  };

  return {
    register(shortcut) {
      if (shortcuts.has(shortcut.id))
        throw new Error(`Shortcut already registered: ${shortcut.id}`);
      const keys = normalizeKeys(shortcut.keys);
      // Two shipped defaults must not clash. An owner's binding can still take a default that
      // isn't registered yet; the Keyboard page refuses the clashes it can see.
      for (const other of shortcuts.values()) {
        if (other.when === shortcut.when && normalizeKeys(other.keys) === keys)
          throw new Error(`${shortcut.id} and ${other.id} both use ${keys} in ${shortcut.when}`);
      }
      shortcuts.set(shortcut.id, shortcut);
      return () => {
        if (shortcuts.get(shortcut.id) === shortcut) shortcuts.delete(shortcut.id);
      };
    },
    setBindings(next) {
      bindings = { ...next };
    },
    keysFor,
    list: () =>
      [...shortcuts.values()].map((shortcut) => ({
        ...shortcut,
        label: typeof shortcut.label === "function" ? shortcut.label() : shortcut.label,
        defaultKeys: shortcut.keys,
        keys: keysFor(shortcut.id) ?? shortcut.keys,
      })),
    handle(event) {
      if (event.defaultPrevented || event.isComposing) return false;
      for (const context of contextsFor(event.target)) {
        for (const shortcut of shortcuts.values()) {
          if (shortcut.when !== context) continue;
          if (!matchesKeys(event, keysFor(shortcut.id) ?? shortcut.keys, options.isMac)) continue;
          if (shortcut.run(event) === false) continue;
          event.preventDefault();
          return true;
        }
      }
      return false;
    },
  };
}

/** The key a press names, as shortcuts store it: what the matcher and the recorder both read. */
export function eventKey(event: Pick<KeyboardEvent, "key" | "code" | "altKey">): string {
  // With Alt held, macOS reports a symbol as `key`; `code` keeps the physical letter.
  if (event.altKey && /^Key[A-Z]$/.test(event.code)) return event.code.slice(3).toLowerCase();
  if (event.altKey && event.code === "Space") return "space";
  return event.key === " " ? "space" : event.key.toLowerCase();
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
