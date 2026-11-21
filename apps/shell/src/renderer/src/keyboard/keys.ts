// D11: turning a key press into a shortcut, finding conflicts and showing keys.
import { eventKey, normalizeKeys, RESERVED_KEYS, type ShortcutContext } from "../shortcuts";

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
  // The same key the matcher reads, so the shortcut fires on every keyboard layout.
  const key = eventKey(event);
  // "+" separates keys, so it can't be one.
  if (key === "+") return null;
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

/** Keys the system or every text field uses: never given to a command. */
export const SYSTEM_KEYS = [
  "Mod+C",
  "Mod+V",
  "Mod+X",
  "Mod+A",
  "Mod+Z",
  "Mod+Shift+Z",
  "Mod+W",
  "Mod+Q",
  "Mod+R",
  "Mod+H",
  "Mod+M",
  "Alt+F4",
];

/** Keys as this system reads them: off a Mac, Ctrl is the same key as Mod. */
function onThisSystem(keys: string, isMac: boolean): string {
  const normal = normalizeKeys(keys);
  if (isMac) return normal;
  const parts = normal.split("+").map((part) => (part === "Ctrl" ? "Mod" : part));
  return normalizeKeys([...new Set(parts)].join("+"));
}

/**
 * What `keys` already belongs to, if anything, for shortcut `id`: a command's label, or
 * `"system"` for keys the system keeps.
 */
export function conflictFor(
  id: string,
  keys: string,
  shortcuts: readonly ListedShortcut[],
  isMac = true,
): string | undefined {
  const normalize = (value: string) => onThisSystem(value, isMac);
  const wanted = normalize(keys);
  if (SYSTEM_KEYS.some((system) => normalize(system) === wanted)) return "system";
  const self = shortcuts.find((shortcut) => shortcut.id === id);
  for (const other of shortcuts) {
    if (other.id === id) continue;
    // Global keys reach every context, so they clash with any; others only within their own.
    const overlaps =
      !self || other.when === self.when || other.when === "global" || self.when === "global";
    if (overlaps && normalize(other.keys) === wanted) return other.label;
  }
  if (self?.defaultKeys && normalize(self.defaultKeys) === wanted) return undefined;
  const reserved = Object.entries(RESERVED_KEYS).find(
    ([reservedKeys]) => normalize(reservedKeys) === wanted,
  );
  return reserved?.[1];
}

const MAC_SYMBOLS: Record<string, string> = { Mod: "⌘", Ctrl: "⌃", Alt: "⌥", Shift: "⇧" };

/** Keys as people read them: ⌘⇧T on the Mac, Ctrl+Shift+T elsewhere. */
export function displayKeys(keys: string, isMac: boolean): string {
  const parts = (isMac ? normalizeKeys(keys) : onThisSystem(keys, false)).split("+");
  if (!isMac) return parts.map((part) => (part === "Mod" ? "Ctrl" : part)).join("+");
  // Mac order: ⌃⌥⇧⌘.
  const order = ["Ctrl", "Alt", "Shift", "Mod"];
  const key = parts.pop() ?? "";
  parts.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return [...parts.map((part) => MAC_SYMBOLS[part] ?? part), key].join("");
}
