// C4: pinned messages. Pins are Zoltbot's own notes about a chat (I2): one settings row per chat,
// written with compare-and-set so two devices pinning at once don't overwrite each other.

export interface MessagePin {
  itemId: string;
  pinnedAt: string;
}

/** Enough for any chat; the strip shows three and lists the rest. */
export const MAX_MESSAGE_PINS = 50;

export const messagePinsKey = (threadId: string) => `chat.pins.${threadId}`;

/** The thread a pins row belongs to, or undefined for any other setting. */
export function messagePinsThread(key: unknown): string | undefined {
  return typeof key === "string" && key.startsWith("chat.pins.")
    ? key.slice("chat.pins.".length) || undefined
    : undefined;
}

/** Reads a stored row, dropping anything malformed; newest pin first. */
export function readMessagePins(value: unknown): MessagePin[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const pins: MessagePin[] = [];
  for (const row of value) {
    const pin = row as Partial<MessagePin> | null;
    if (typeof pin?.itemId !== "string" || !pin.itemId || seen.has(pin.itemId)) continue;
    seen.add(pin.itemId);
    pins.push({
      itemId: pin.itemId,
      pinnedAt: typeof pin.pinnedAt === "string" ? pin.pinnedAt : "",
    });
  }
  return pins.sort((a, b) => b.pinnedAt.localeCompare(a.pinnedAt));
}

/** The list after pinning or unpinning one message. Pinning again keeps its first time. */
export function withMessagePin(
  value: unknown,
  itemId: string,
  pinned: boolean,
  at: string,
): MessagePin[] {
  const pins = readMessagePins(value).filter((pin) => pin.itemId !== itemId || pinned);
  if (!pinned || pins.some((pin) => pin.itemId === itemId)) return pins;
  if (pins.length >= MAX_MESSAGE_PINS) throw new Error("pin_limit");
  return [{ itemId, pinnedAt: at }, ...pins];
}
