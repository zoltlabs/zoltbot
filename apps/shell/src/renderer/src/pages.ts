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
