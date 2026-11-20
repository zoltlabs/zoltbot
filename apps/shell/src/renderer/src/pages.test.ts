import { createRoot } from "solid-js";
import { describe, expect, it } from "vitest";
import { CHAT_ROUTE, createPages, PAGES, pageFlag } from "./pages";
import { RESERVED_KEYS } from "./shortcuts";

describe("pages", () => {
  it("navigates, goes back and forward, and drops removed chats", () => {
    createRoot((dispose) => {
      const pages = createPages({ id: "chat", threadId: "a" });
      expect(pages.canGoBack()).toBe(false);
      pages.navigate({ id: "tasks", projectId: null });
      pages.navigate({ id: "chat", threadId: "b" });
      expect(pages.is("chat")).toBe(true);
      pages.back();
      expect(pages.location()).toEqual({ id: "tasks", projectId: null });
      expect(pages.canGoForward()).toBe(true);
      pages.forward();
      expect(pages.location()).toEqual({ id: "chat", threadId: "b" });
      pages.remove((route) => route.id === "chat" && route.threadId === "b", { id: "map" });
      expect(pages.location()).toEqual({ id: "tasks", projectId: null });
      pages.replace({ id: "models" });
      expect(pages.location()).toEqual({ id: "models" });
      pages.back();
      expect(pages.location()).toEqual({ id: "chat", threadId: "a" });
      dispose();
    });
  });

  it("lists every page once, with shortcuts from the reserved list", () => {
    for (const [id, page] of Object.entries(PAGES)) {
      expect(page.id).toBe(id);
      if (page.shortcut) expect(RESERVED_KEYS[page.shortcut]).toBe(page.label);
    }
  });

  it("backs open and closed flags with the page history", () => {
    createRoot((dispose) => {
      const pages = createPages(CHAT_ROUTE);
      let project: string | null = "p1";
      const [mapOpen, setMapOpen] = pageFlag(pages, "map");
      const [tasksOpen, setTasksOpen] = pageFlag(pages, "tasks", () => ({
        id: "tasks",
        projectId: project,
      }));
      setMapOpen(true);
      expect(mapOpen()).toBe(true);
      setTasksOpen(false);
      expect(mapOpen()).toBe(true);
      setMapOpen(false);
      setTasksOpen(true);
      expect([mapOpen(), tasksOpen()]).toEqual([false, true]);
      expect(pages.location()).toEqual({ id: "tasks", projectId: "p1" });
      project = "p2";
      setTasksOpen(true);
      expect(pages.location()).toEqual({ id: "tasks", projectId: "p2" });
      pages.back();
      expect(pages.location()).toEqual({ id: "tasks", projectId: "p1" });
      setTasksOpen(false);
      expect(pages.location()).toEqual(CHAT_ROUTE);
      dispose();
    });
  });
});
