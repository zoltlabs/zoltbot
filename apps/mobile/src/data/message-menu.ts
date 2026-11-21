// P5: what touching and holding a message offers, and the time a left drag shows. Pure, so the
// menu's order and contents are testable; ui/MessageMenu.tsx runs the actions.

export type MenuKey =
  | "reply"
  | "copy"
  | "pin"
  | "unpin"
  | "read"
  | "stopReading"
  | "branch"
  | "hide"
  | "react"
  | "edit"
  | "forward"
  | "share"
  | "sendNow"
  | "moveUp"
  | "moveDown"
  | "remove";

export interface MenuItem {
  key: MenuKey;
  label: string;
}

/** What this message allows right now. */
export interface MenuCaps {
  mine: boolean;
  hasText: boolean;
  /** Can be replied to, pinned, hidden and reacted to (a real message, the chat online). */
  markable: boolean;
  pinned: boolean;
  readable: boolean;
  reading: boolean;
  branch: boolean;
  /** Edit a queued message, or start a new chat from before a sent one. */
  edit?: "queued" | "sent";
  forward: boolean;
  queue?: { moveUp: boolean; moveDown: boolean };
}

const item = (key: MenuKey, label: string): MenuItem => ({ key, label });

export function messageMenu(caps: MenuCaps): MenuItem[] {
  const copy = caps.hasText ? [item("copy", "Copy")] : [];
  if (caps.queue)
    return [
      item("sendNow", "Send now"),
      ...(caps.edit ? [item("edit", "Edit")] : []),
      ...(caps.queue.moveUp ? [item("moveUp", "Move up")] : []),
      ...(caps.queue.moveDown ? [item("moveDown", "Move down")] : []),
      ...copy,
      ...(caps.hasText ? [item("share", "Share message")] : []),
      item("remove", "Remove"),
    ];
  return [
    ...(caps.markable ? [item("reply", "Reply")] : []),
    ...copy,
    ...(caps.pinned ? [item("unpin", "Unpin")] : caps.markable ? [item("pin", "Pin")] : []),
    ...(caps.readable
      ? [caps.reading ? item("stopReading", "Stop reading") : item("read", "Read aloud")]
      : []),
    ...(caps.branch ? [item("branch", "Branch from here")] : []),
    ...(caps.markable ? [item("hide", "Hide"), item("react", "React")] : []),
    ...(caps.edit ? [item("edit", caps.edit === "queued" ? "Edit" : "Edit and send again")] : []),
    ...(caps.forward ? [item("forward", "Send to another chat")] : []),
    ...(caps.hasText ? [item("share", "Share message")] : []),
  ];
}

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

/** "3:42 PM" today, "Mon 3:42 PM" within the week, "12 Mar, 3:42 PM" before that. */
export function messageTime(at: string | undefined, now = new Date(), locale?: string): string {
  if (!at) return "";
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return "";
  const time = when.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  if (sameDay(when, now)) return time;
  const days = (now.getTime() - when.getTime()) / 86_400_000;
  if (days > 0 && days < 6)
    return `${when.toLocaleDateString(locale, { weekday: "short" })} ${time}`;
  const date = when.toLocaleDateString(locale, {
    day: "numeric",
    month: "short",
    ...(when.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
  return `${date}, ${time}`;
}
