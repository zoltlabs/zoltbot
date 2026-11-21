// D11: turning a key press into a shortcut, finding conflicts and showing keys.
import { normalizeKeys, RESERVED_KEYS, type ShortcutContext } from "../shortcuts";

const MODIFIER_KEYS = new Set(["Meta", "Control", "Shift", "Alt", "CapsLock", "Fn"]);

/** The shortcut a key press makes, or null while only modifiers are held or none is. */
export function keysFromEvent(
  event: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  isMac: boolean,
): string | null {
  if (MODIFIER_KEYS.has(event.key)) return null;
  const mod = isMac ? event.metaKey : event.ctrlKey;
  const ctrl = isMac && event.ctrlKey;
  // A shortcut without ⌘, Ctrl or Option would fire while typing.
  if (!mod && !ctrl && !event.altKey) return null;
  const key = /^Key[A-Z]$/.test(event.code)
    ? event.code.slice(3)
    : /^Digit\d$/.test(event.code)
      ? event.code.slice(5)
      : event.key === " "
        ? "Space"
        : event.key;
  const parts = [mod && "Mod", ctrl && "Ctrl", event.altKey && "Alt", event.shiftKey && "Shift"];
  return normalizeKeys([...parts.filter(Boolean), key].join("+"));
}

export interface ListedShortcut {
  id: string;
  label: string;
  keys: string;
  when: ShortcutContext;
  /** The keys it shipped with; a reserved combination it already owns isn't a conflict. */
  defaultKeys?: string;
}

/** The command `keys` already belongs to, if any, for shortcut `id`. */
export function conflictFor(
  id: string,
  keys: string,
  shortcuts: readonly ListedShortcut[],
): string | undefined {
  const wanted = normalizeKeys(keys);
  const self = shortcuts.find((shortcut) => shortcut.id === id);
  for (const other of shortcuts) {
    if (other.id === id) continue;
    // Global keys reach every context, so they clash with any; others only within their own.
    const overlaps =
      !self || other.when === self.when || other.when === "global" || self.when === "global";
    if (overlaps && normalizeKeys(other.keys) === wanted) return other.label;
  }
  if (self?.defaultKeys && normalizeKeys(self.defaultKeys) === wanted) return undefined;
  const reserved = Object.entries(RESERVED_KEYS).find(
    ([reservedKeys]) => normalizeKeys(reservedKeys) === wanted,
  );
  return reserved?.[1];
}

const MAC_SYMBOLS: Record<string, string> = { Mod: "⌘", Ctrl: "⌃", Alt: "⌥", Shift: "⇧" };

/** Keys as people read them: ⌘⇧T on the Mac, Ctrl+Shift+T elsewhere. */
export function displayKeys(keys: string, isMac: boolean): string {
  const parts = normalizeKeys(keys).split("+");
  if (!isMac) return parts.map((part) => (part === "Mod" ? "Ctrl" : part)).join("+");
  // Mac order: ⌃⌥⇧⌘.
  const order = ["Ctrl", "Alt", "Shift", "Mod"];
  const key = parts.pop() ?? "";
  parts.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return [...parts.map((part) => MAC_SYMBOLS[part] ?? part), key].join("");
}
