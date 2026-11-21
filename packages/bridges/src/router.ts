// I1: which route a message takes, whether its sender may talk, and the text the agent reads.
import {
  BRIDGE_APP_NAMES,
  BRIDGE_DIRECT,
  type Bridge,
  type BridgeKind,
  type BridgeRoute,
} from "@zoltbot/protocol";
import type { InboundMessage } from "./adapter.js";

/** A place's own route first, then the direct-message route for DMs. */
export function routeFor(bridge: Pick<Bridge, "routes">, message: InboundMessage) {
  return (
    bridge.routes.find((route) => route.from.id === message.place.id) ??
    (message.place.direct
      ? bridge.routes.find((route) => route.from.id === BRIDGE_DIRECT)
      : undefined)
  );
}

export const allowed = (route: BridgeRoute, senderId: string) =>
  route.allow.some((person) => person.id === senderId);

/** Long enough for a real message, short enough that one can't flood a chat. */
export const MAX_BRIDGED_TEXT = 8000;

/**
 * What the agent reads. Naming the sender and the app tells the agent it isn't the owner talking,
 * and the fixed opening means a leading "/" can't run one of the agent's commands, whatever the
 * sender calls themselves.
 */
export function bridgedText(kind: BridgeKind, message: InboundMessage): string {
  const name = oneLine(message.sender.name) || message.sender.id;
  const where = message.place.direct ? "" : ` in ${oneLine(message.place.label) || "a channel"}`;
  const body = message.text.trim().slice(0, MAX_BRIDGED_TEXT);
  return `Message from ${name} on ${BRIDGE_APP_NAMES[kind]}${where}:\n${body}`;
}

const oneLine = (value: string) =>
  value
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, 80);

/** Splits a reply into posts the app accepts, at paragraph, then line, then word breaks. */
export function splitText(text: string, limit: number): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const cut = Math.max(
      window.lastIndexOf("\n\n"),
      window.lastIndexOf("\n") > limit / 2 ? window.lastIndexOf("\n") : -1,
    );
    const at =
      cut > limit / 4 ? cut : window.lastIndexOf(" ") > limit / 2 ? window.lastIndexOf(" ") : limit;
    parts.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}
