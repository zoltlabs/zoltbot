import { encode } from "uqr";
import type { Row } from "../chat/types.js";

export interface DeviceRow {
  id: string;
  name: string;
  state: "pending" | "paired" | "revoked";
  confirmCode?: string;
  pairedAt?: string;
  lastSeenAt?: string;
  archived: boolean;
}

export function deviceRows(rows: readonly Row[]) {
  const devices = (rows as unknown as DeviceRow[])
    .filter((row) => !row.archived && row.state !== "revoked")
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    pending: devices.filter((row) => row.state === "pending"),
    paired: devices.filter((row) => row.state === "paired"),
  };
}

/** "123 456", easier to compare at a glance than six digits in a row. */
export const spacedCode = (code = "") => code.replace(/^(\d{3})(\d{3})$/, "$1 $2");

export function lastSeen(at: string | undefined, now = Date.now()) {
  const time = at ? Date.parse(at) : Number.NaN;
  if (Number.isNaN(time)) return "Not seen yet";
  const minutes = Math.max(0, Math.round((now - time) / 60_000));
  if (minutes < 1) return "Last seen just now";
  if (minutes < 60) return `Last seen ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Last seen ${hours} h ago`;
  return `Last seen ${new Date(time).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

export function deviceError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("relay_not_set")) return "Add a relay address first.";
  if (message.startsWith("relay_offline"))
    return "Zoltbot cannot reach the relay. Check the address and try again.";
  if (message.startsWith("invalid_relay_url"))
    return "Use a wss:// address. Plain ws:// works only for this computer.";
  if (message.startsWith("keychain_unavailable"))
    return "Zoltbot could not reach the Keychain on this Mac.";
  return "Could not finish this. Reconnect and try again.";
}

/** One SVG path for the dark modules, so the code stays crisp at any size. */
export function qrPath(text: string) {
  const { data, size } = encode(text, { ecc: "M", border: 2 });
  let path = "";
  data.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) path += `M${x} ${y}h1v1h-1z`;
    });
  });
  return { path, size };
}
