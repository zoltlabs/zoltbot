import { describe, expect, it } from "vitest";
import {
  canGoBack,
  canGoForward,
  goBack,
  goForward,
  HISTORY_LIMIT,
  push,
  type Route,
  removeRoutes,
  replace,
  routesEqual,
  startNavigation,
} from "./navigation";

const chat = (threadId: string): Route => ({ id: "chat", threadId });
const tasks: Route = { id: "tasks", projectId: null };
const map: Route = { id: "map" };

describe("navigation history", () => {
  it("pushes routes and clears forward history", () => {
    let state = push(push(startNavigation(chat("a")), tasks), map);
    expect(state.back).toEqual([chat("a"), tasks]);
    state = goBack(state);
    expect(state.forward).toEqual([map]);
    state = push(state, chat("b"));
    expect(state).toEqual({ back: [chat("a"), tasks], current: chat("b"), forward: [] });
  });

  it("ignores a push of the current route", () => {
    const state = startNavigation(chat("a"));
    expect(push(state, chat("a"))).toBe(state);
  });

  it("goes back and forward, and stops at either end", () => {
    let state = push(push(startNavigation(chat("a")), tasks), map);
    state = goBack(goBack(state));
    expect(state.current).toEqual(chat("a"));
    expect(canGoBack(state)).toBe(false);
    expect(goBack(state)).toBe(state);
    state = goForward(state);
    expect(state.current).toEqual(tasks);
    state = goForward(state);
    expect(state.current).toEqual(map);
    expect(canGoForward(state)).toBe(false);
    expect(goForward(state)).toBe(state);
  });

  it("replaces the current route without a history entry", () => {
    const state = replace(push(startNavigation(chat("a")), tasks), map);
    expect(state).toEqual({ back: [chat("a")], current: map, forward: [] });
  });

  it("keeps at most the history limit", () => {
    let state = startNavigation(chat("0"));
    for (let index = 1; index <= HISTORY_LIMIT + 5; index++) state = push(state, chat(`${index}`));
    expect(state.back).toHaveLength(HISTORY_LIMIT);
    expect(state.back[0]).toEqual(chat("5"));
  });

  it("drops a removed chat from history and moves off it when it is current", () => {
    let state = push(push(push(startNavigation(chat("a")), chat("b")), chat("a")), chat("b"));
    state = goBack(state);
    // back: a, b — current: a — forward: b
    const removed = removeRoutes(state, (route) => routesEqual(route, chat("a")), map);
    expect(removed).toEqual({ back: [], current: chat("b"), forward: [] });
  });

  it("uses the fallback when nothing is left to go back to", () => {
    const state = startNavigation(chat("a"));
    expect(removeRoutes(state, (route) => route.id === "chat", tasks)).toEqual({
      back: [],
      current: tasks,
      forward: [],
    });
  });

  it("merges neighbours that become duplicates after a removal", () => {
    let state = startNavigation(map);
    for (const route of [chat("x"), map, chat("y")]) state = push(state, route);
    const removed = removeRoutes(state, (route) => routesEqual(route, chat("x")), tasks);
    expect(removed).toEqual({ back: [map], current: chat("y"), forward: [] });
  });

  it("compares routes by their parameters", () => {
    expect(routesEqual(chat("a"), chat("a"))).toBe(true);
    expect(routesEqual(chat("a"), chat("b"))).toBe(false);
    expect(routesEqual(tasks, { id: "tasks", projectId: "p" })).toBe(false);
    expect(routesEqual(map, { id: "map" })).toBe(true);
  });

  it("lets the next route take the place of a chat with no thread", () => {
    const closed = push(push(startNavigation(chat("a")), map), chat(""));
    const next = push(closed, tasks);
    expect(next.back).toEqual([chat("a"), map]);
    expect(next.current).toEqual(tasks);
  });

  it("keeps the same history when nothing was removed", () => {
    const state = push(startNavigation(chat("a")), map);
    expect(removeRoutes(state, () => false, chat(""))).toBe(state);
  });
});
