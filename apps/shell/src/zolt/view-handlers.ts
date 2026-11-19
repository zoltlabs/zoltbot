import {
  IPC_CHANNELS,
  VIEW_PERMISSIONS,
  type ViewConnectInput,
  type ViewPermission,
  type ViewTheme,
  type ViewUpdateInput,
} from "../shared/ipc";
import type { Handler } from "./agent-handlers";
import { isObject, requireString } from "./parsers";
import type { ViewHost } from "./view-host";

/**
 * The renderer's view calls. Electron main registers the invoke handlers; `post`, `update` and
 * `close` arrive as one-way messages and go through `viewMessages`. The headless browser tests
 * use the same tables.
 */
export function viewHandlers(host: ViewHost): Record<string, Handler> {
  return {
    [IPC_CHANNELS.viewGetMap]: () => host.mapView(),
    [IPC_CHANNELS.viewSetGrants]: (input) => {
      if (!isObject(input)) throw new Error("Invalid view permissions.");
      return host.setGrants(
        requireString(input.viewId, "viewId"),
        parsePermissions(input.permissions),
      );
    },
    [IPC_CHANNELS.viewTurnOn]: (id) => host.turnOn(requireString(id, "viewId")),
    [IPC_CHANNELS.viewPrepare]: (id) => host.prepare(requireString(id, "viewId")),
    [IPC_CHANNELS.viewConnect]: (input) => host.connect(parseViewConnect(input)),
  };
}

export function viewMessages(host: ViewHost): Record<string, (...values: unknown[]) => void> {
  return {
    [IPC_CHANNELS.viewPost]: (sessionId, message) => {
      if (typeof sessionId === "string") host.receive(sessionId, message);
    },
    [IPC_CHANNELS.viewUpdate]: (input) => host.update(parseViewUpdate(input)),
    [IPC_CHANNELS.viewClose]: (sessionId) => host.close(requireString(sessionId, "sessionId")),
    [IPC_CHANNELS.viewShortcut]: (sessionId, shortcutId) =>
      host.shortcut(requireString(sessionId, "sessionId"), requireString(shortcutId, "shortcutId")),
  };
}

export function parsePermissions(value: unknown): ViewPermission[] {
  if (
    !Array.isArray(value) ||
    value.length > VIEW_PERMISSIONS.length ||
    !value.every((item) => VIEW_PERMISSIONS.includes(item))
  )
    throw new Error("Invalid view permissions.");
  return [...new Set(value as ViewPermission[])];
}

export function parseViewConnect(value: unknown): ViewConnectInput {
  if (!isObject(value)) throw new Error("Invalid view request.");
  return {
    viewId: requireString(value.viewId, "viewId"),
    theme: parseViewTheme(value.theme),
    locale: typeof value.locale === "string" ? value.locale.slice(0, 35) : "en",
    reducedMotion: value.reducedMotion === true,
  };
}

function parseViewUpdate(value: unknown): ViewUpdateInput {
  if (!isObject(value)) throw new Error("Invalid view update.");
  return {
    sessionId: requireString(value.sessionId, "sessionId"),
    ...(typeof value.visible === "boolean" ? { visible: value.visible } : {}),
    ...(value.theme !== undefined ? { theme: parseViewTheme(value.theme) } : {}),
  };
}

function parseViewTheme(value: unknown): ViewTheme {
  if (!isObject(value) || !isObject(value.tokens)) throw new Error("Invalid view theme.");
  const tokens: Record<string, string> = {};
  for (const [name, token] of Object.entries(value.tokens).slice(0, 500))
    if (name.startsWith("--zb-") && typeof token === "string" && token.length <= 500)
      tokens[name] = token;
  const text = (input: unknown) => (typeof input === "string" ? input.slice(0, 500) : "");
  return {
    scheme: value.scheme === "light" ? "light" : "dark",
    tokens,
    fontSans: text(value.fontSans),
    fontMono: text(value.fontMono),
    fontScale:
      typeof value.fontScale === "number" && value.fontScale > 0 && value.fontScale <= 4
        ? value.fontScale
        : 1,
  };
}
