// I1: what the Bridges dialog shows for a bridge, apart from the components.
import type {
  Bridge,
  BridgeInput,
  BridgeKind,
  BridgeRoute,
  BridgeStatus,
  BridgeView,
} from "@zoltbot/protocol";
import { BRIDGE_APP_NAMES, BRIDGE_DIRECT } from "@zoltbot/protocol";
import { t } from "../../i18n";

export const appName = (kind: BridgeKind) => BRIDGE_APP_NAMES[kind];

export function statusLabel(status: BridgeStatus) {
  if (status.state === "connected") return t("bridges.status.connected");
  if (status.state === "reconnecting") return t("bridges.status.reconnecting");
  return t("bridges.status.stopped");
}

/** The step that gets a stopped bridge going again, or nothing when it runs or was stopped. */
export function problemText(status: BridgeStatus): string | undefined {
  if (status.state !== "stopped" || !status.problem) return undefined;
  if (status.problem === "token_refused") return t("bridges.problem.tokenRefused");
  if (status.problem === "token_in_use") return t("bridges.problem.tokenInUse");
  if (status.problem === "keychain_unavailable") return t("bridges.problem.keychain");
  if (status.problem === "needs_account") return t("bridges.problem.needsAccount");
  if (status.problem === "not_set_up") return t("bridges.problem.notSetUp");
  return undefined;
}

export function toInput(bridge: Bridge): BridgeInput {
  return {
    id: bridge.id,
    kind: bridge.kind,
    label: bridge.label,
    enabled: bridge.enabled,
    routes: bridge.routes,
    ...(bridge.options ? { options: bridge.options } : {}),
  };
}

export const placeLabel = (route: Pick<BridgeRoute, "from">) =>
  route.from.id === BRIDGE_DIRECT
    ? t("route.direct")
    : route.from.label.trim() || route.from.id;

/** Places the owner may want to route: existing routes and where refused people wrote. */
export function knownPlaces(view: BridgeView) {
  const places = new Map<string, string>();
  for (const route of view.bridge.routes) places.set(route.from.id, route.from.label);
  for (const entry of view.refused)
    if (!places.has(entry.place.id)) places.set(entry.place.id, entry.place.label);
  places.delete(BRIDGE_DIRECT);
  return [...places].map(([id, label]) => ({ id, label: label.trim() || id }));
}

/** randomUUID needs a secure context; getRandomValues works everywhere. */
export const newId = (prefix: string) =>
  `${prefix}-${[...crypto.getRandomValues(new Uint8Array(6))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
