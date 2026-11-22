// The app's pages and where it is now. `navigation.ts` holds the history rules;
// this wraps them in signals for the renderer and lists each page once, for the
// sidebar, the command palette (S7) and the design checks (F8).
import { createSignal } from "solid-js";
import {
  canGoBack,
  canGoForward,
  goBack,
  goForward,
  type NavigationState,
  push,
  type Route,
  type RouteId,
  removeRoutes,
  replace,
  startNavigation,
} from "./navigation";

export interface PageInfo {
  id: RouteId;
  /** The page's name in menus and the command palette. */
  label: string;
  /** Keys that open it from anywhere, from the reserved list in shortcuts.ts. */
  shortcut?: string;
  /** Pages with their own sidebar entry, rather than one per chat or channel. */
  inSidebar: boolean;
}

export const PAGES: Readonly<Record<RouteId, PageInfo>> = {
  chat: { id: "chat", label: "Chat", inSidebar: false },
  channel: { id: "channel", label: "Channel", inSidebar: false },
  tasks: { id: "tasks", label: "Tasks", shortcut: "Mod+T", inSidebar: true },
  map: { id: "map", label: "Map", inSidebar: true },
  models: { id: "models", label: "Models", inSidebar: true },
  memory: { id: "memory", label: "Memory", inSidebar: true },
  usage: { id: "usage", label: "Usage", inSidebar: true },
  routines: { id: "routines", label: "Routines", inSidebar: true },
  vault: { id: "vault", label: "Vault", inSidebar: true },
  data: { id: "data", label: "Data", inSidebar: true },
  /** One per project, under the project in the sidebar. */
  documents: { id: "documents", label: "Documents", inSidebar: false },
};

export type Pages = ReturnType<typeof createPages>;

/** The current page and its history, as signals. */
export function createPages(initial: Route) {
  const [state, setState] = createSignal<NavigationState>(startNavigation(initial));
  const location = () => state().current;
  return {
    location,
    /** Whether the current page is `id`, for the sidebar's selected state. */
    is: (id: RouteId) => location().id === id,
    navigate: (route: Route) => setState((current) => push(current, route)),
    /** Changes the current page without a history entry, such as a chat that was renamed. */
    replace: (route: Route) => setState((current) => replace(current, route)),
    back: () => setState(goBack),
    forward: () => setState(goForward),
    canGoBack: () => canGoBack(state()),
    canGoForward: () => canGoForward(state()),
    /** Drops pages that no longer exist, such as a deleted chat, from the history. */
    remove: (gone: (route: Route) => boolean, fallback: Route) =>
      setState((current) => removeRoutes(current, gone, fallback)),
  };
}

/** The chat page as a route, used when another page closes. */
export const CHAT_ROUTE: Route = { id: "chat", threadId: "" };

/**
 * An open/closed signal pair backed by the page history, so code that opens and closes one
 * page at a time keeps working while the pages move to routes.
 */
export function pageFlag(
  pages: Pages,
  id: Exclude<RouteId, "chat" | "channel">,
  route: () => Route = () => ({ id }) as Route,
): [() => boolean, (open: boolean) => void] {
  return [
    () => pages.is(id),
    (open) => {
      if (open) pages.navigate(route());
      // Closing is a visit to the chat, so Back can reopen the page.
      else if (pages.is(id)) pages.navigate(CHAT_ROUTE);
    },
  ];
}
