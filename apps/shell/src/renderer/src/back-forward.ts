// Back and forward through chats, channels and pages (C19). The page history in
// `pages.ts` already records pages; this records which chat or channel was open,
// replays a route when Back or Forward lands on it, and drops chats and channels
// that were deleted or archived.
import { createEffect, on, onCleanup, untrack } from "solid-js";
import { useShortcut } from "./app-shortcuts";
import { t } from "./i18n";
import { isStandIn, type Route, routesEqual } from "./navigation";
import { CHAT_ROUTE, type Pages } from "./pages";

export interface BackForwardOptions {
  pages: Pages;
  /** The chat the conversation shows, or "" before any chat loads. */
  chatId: () => string;
  /** The open channel, which covers the chat. */
  channelId: () => string | null;
  chatExists: (threadId: string) => boolean;
  channelExists: (channelId: string) => boolean;
  showChat: (threadId: string) => void;
  showChannel: (channelId: string) => void;
  closeChannel: () => void;
  /** False during first-run setup or while a dialog covers the app. */
  enabled: () => boolean;
}

/** Mouse buttons 4 and 5, which Chromium reports as 3 and 4. */
export const MOUSE_BACK = 3;
export const MOUSE_FORWARD = 4;

/** True for a chat or channel that no longer exists. Pages never go away. */
export function isGone(
  route: Route,
  chatExists: (threadId: string) => boolean,
  channelExists: (channelId: string) => boolean,
): boolean {
  if (route.id === "chat") return !isStandIn(route) && !chatExists(route.threadId);
  if (route.id === "channel") return !channelExists(route.channelId);
  return false;
}

/** The route for what the app shows when no page covers it. */
export function placeRoute(chatId: string, channelId: string | null): Route {
  return channelId ? { id: "channel", channelId } : { id: "chat", threadId: chatId };
}

function isPlace(route: Route): boolean {
  return route.id === "chat" || route.id === "channel";
}

export function createBackForward(options: BackForwardOptions) {
  const { pages } = options;
  let recordQueued = false;

  const placeGone = (place: Route) => isGone(place, options.chatExists, options.channelExists);
  /** Whether the open chat or channel is in its list yet; recording waits for it. */
  const placeExists = () => !placeGone(placeRoute(options.chatId(), options.channelId()));

  // A sidebar click closes pages and opens a chat in several steps; record once they settle.
  function record() {
    recordQueued = false;
    const at = pages.location();
    if (!isPlace(at)) return;
    const place = placeRoute(options.chatId(), options.channelId());
    // A chat opened before it reaches the chat list, such as a continued side question, waits
    // until it's there; recording it sooner lets pruning remove it again, over and over.
    if (isStandIn(place) || routesEqual(at, place) || placeGone(place)) return;
    if (isStandIn(at)) pages.replace(place);
    else pages.navigate(place);
  }

  createEffect(
    on([pages.location, options.chatId, options.channelId, placeExists], () => {
      if (recordQueued) return;
      recordQueued = true;
      queueMicrotask(record);
    }),
  );

  // Replays the route Back or Forward landed on. Only a location change runs this, so closing
  // a channel on the way to a page doesn't reopen it.
  createEffect(
    on(pages.location, (at) => {
      untrack(() => {
        if (at.id === "channel") {
          if (options.channelId() !== at.channelId) options.showChannel(at.channelId);
          return;
        }
        if (options.channelId() !== null) options.closeChannel();
        if (at.id === "chat" && !isStandIn(at) && options.chatId() !== at.threadId)
          options.showChat(at.threadId);
      });
    }),
  );

  const gone = (route: Route) => isGone(route, options.chatExists, options.channelExists);
  const prune = () => {
    // When the open chat or channel goes, the app picks the next chat; the stand-in holds its
    // place until then, rather than stepping back to whatever page came before.
    if (gone(untrack(pages.location))) pages.replace(CHAT_ROUTE);
    pages.remove(gone, CHAT_ROUTE);
  };
  // Deleting or archiving a chat or channel takes it out of the history. Reading the location
  // re-checks each new entry; the checks themselves follow the chat and channel lists.
  createEffect(() => {
    pages.location();
    prune();
  });

  /** Moves through the history; false when setup or a dialog has the app. */
  const move = (step: () => void) => () => {
    if (!options.enabled()) return false;
    prune();
    step();
    return true;
  };
  const back = move(pages.back);
  const forward = move(pages.forward);

  useShortcut({
    id: "app.back",
    keys: "Mod+[",
    when: "global",
    label: () => t("nav.back"),
    run: () => (back() ? undefined : false),
  });
  useShortcut({
    id: "app.forward",
    keys: "Mod+]",
    when: "global",
    label: () => t("nav.forward"),
    run: () => (forward() ? undefined : false),
  });

  const onMouseUp = (event: MouseEvent) => {
    const moved =
      event.button === MOUSE_BACK ? back() : event.button === MOUSE_FORWARD ? forward() : false;
    if (moved) event.preventDefault();
  };
  window.addEventListener("mouseup", onMouseUp);
  onCleanup(() => window.removeEventListener("mouseup", onMouseUp));

  return { back, forward, canGoBack: pages.canGoBack, canGoForward: pages.canGoForward };
}
