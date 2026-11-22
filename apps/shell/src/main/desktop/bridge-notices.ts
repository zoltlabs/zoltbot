// I1: someone wrote through a bridge but isn't on the route's list. They get no reply; the owner
// gets one notice, so they can allow them in Bridges.
import { BRIDGE_DIRECT, bridgeRow } from "@zoltbot/protocol";

/** Only a fresh refusal notifies, not ones already saved when the app starts. */
const FRESH_MS = 2 * 60 * 1000;

export function bridgeRefusalNotice(
  payload: Record<string, unknown>,
  now = Date.now(),
): { id: string; threadId: string; text: string } | undefined {
  if (bridgeRow(payload.key)?.row !== "refused" || !Array.isArray(payload.value)) return undefined;
  // The daemon puts the new refusal first.
  const entry = payload.value[0] as
    | {
        id?: unknown;
        at?: unknown;
        person?: { id?: unknown; name?: unknown };
        place?: { id?: unknown; label?: unknown };
      }
    | undefined;
  if (typeof entry?.id !== "string" || typeof entry.at !== "string") return undefined;
  if (now - Date.parse(entry.at) > FRESH_MS) return undefined;
  const name = String(entry.person?.name || entry.person?.id || "Someone");
  const label = String(entry.place?.label ?? "");
  const place = entry.place?.id === BRIDGE_DIRECT || !label ? "direct messages" : label;
  return { id: entry.id, threadId: "bridges", text: `${name} isn’t on the list for ${place}.` };
}
