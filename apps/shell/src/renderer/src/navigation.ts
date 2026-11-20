// Page routes and the back/forward history behind them. Pure functions, so the
// history rules are tested without a renderer; `pages.ts` wraps them in signals.

export type Route =
  | { id: "chat"; threadId: string }
  | { id: "channel"; channelId: string }
  | { id: "tasks"; projectId: string | null }
  | { id: "map" }
  | { id: "models" };

export type RouteId = Route["id"];

export interface NavigationState {
  back: readonly Route[];
  current: Route;
  forward: readonly Route[];
}

/** Older entries drop off the back of the history beyond this many. */
export const HISTORY_LIMIT = 50;

export function routesEqual(a: Route, b: Route): boolean {
  if (a.id !== b.id) return false;
  switch (a.id) {
    case "chat":
      return a.threadId === (b as typeof a).threadId;
    case "channel":
      return a.channelId === (b as typeof a).channelId;
    case "tasks":
      return a.projectId === (b as typeof a).projectId;
    default:
      return true;
  }
}

export function startNavigation(route: Route): NavigationState {
  return { back: [], current: route, forward: [] };
}

/** Opens a route. Visiting the current route again changes nothing. */
export function push(state: NavigationState, route: Route): NavigationState {
  if (routesEqual(state.current, route)) return state;
  return {
    back: [...state.back, state.current].slice(-HISTORY_LIMIT),
    current: route,
    forward: [],
  };
}

/** Swaps the current route without adding a history entry. */
export function replace(state: NavigationState, route: Route): NavigationState {
  if (routesEqual(state.current, route)) return state;
  return { ...state, current: route };
}

export function canGoBack(state: NavigationState): boolean {
  return state.back.length > 0;
}

export function canGoForward(state: NavigationState): boolean {
  return state.forward.length > 0;
}

export function goBack(state: NavigationState): NavigationState {
  const previous = state.back.at(-1);
  if (!previous) return state;
  return {
    back: state.back.slice(0, -1),
    current: previous,
    forward: [state.current, ...state.forward],
  };
}

export function goForward(state: NavigationState): NavigationState {
  const [next, ...rest] = state.forward;
  if (!next) return state;
  return { back: [...state.back, state.current], current: next, forward: rest };
}

/**
 * Drops routes that no longer exist, such as a deleted chat. When the current
 * route is gone, it moves to the newest remaining back entry, or to `fallback`.
 * Neighbouring duplicates left behind by the removal are merged.
 */
export function removeRoutes(
  state: NavigationState,
  gone: (route: Route) => boolean,
  fallback: Route,
): NavigationState {
  const back = dedupe(state.back.filter((route) => !gone(route)));
  const forward = dedupe(state.forward.filter((route) => !gone(route)));
  if (!gone(state.current)) return trimAround({ back, current: state.current, forward });
  const previous = back.at(-1);
  if (previous) return trimAround({ back: back.slice(0, -1), current: previous, forward });
  return trimAround({ back: [], current: fallback, forward });
}

function dedupe(routes: readonly Route[]): Route[] {
  return routes.filter((route, index) => index === 0 || !routesEqual(route, routes[index - 1]));
}

function trimAround(state: NavigationState): NavigationState {
  const back =
    state.back.length > 0 && routesEqual(state.back.at(-1) as Route, state.current)
      ? state.back.slice(0, -1)
      : state.back;
  const forward =
    state.forward.length > 0 && routesEqual(state.forward[0], state.current)
      ? state.forward.slice(1)
      : state.forward;
  return { back, current: state.current, forward };
}
