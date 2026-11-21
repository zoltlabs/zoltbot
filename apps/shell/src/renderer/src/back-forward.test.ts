import { createRoot, createSignal } from "solid-js";
import { describe, expect, it } from "vitest";
import { createBackForward, isGone, MOUSE_BACK, MOUSE_FORWARD, placeRoute } from "./back-forward";
import { CHAT_ROUTE, createPages, pageFlag } from "./pages";

const settle = () => new Promise<void>((resolve) => queueMicrotask(resolve));

function setup() {
  const [chatId, setChatId] = createSignal("");
  const [channelId, setChannelId] = createSignal<string | null>(null);
  const [chats, setChats] = createSignal(["a", "b", "c"]);
  const [channels, setChannels] = createSignal(["general"]);
  const pages = createPages(CHAT_ROUTE);
  const [, setTasksOpen] = pageFlag(pages, "tasks", () => ({ id: "tasks", projectId: null }));
  const history = createBackForward({
    pages,
    chatId,
    channelId,
    chatExists: (id) => chats().includes(id),
    channelExists: (id) => channels().includes(id),
    showChat: setChatId,
    showChannel: setChannelId,
    closeChannel: () => setChannelId(null),
    enabled: () => true,
  });
  /** What the sidebar does when a chat is clicked: close any page, then show the chat. */
  const selectChat = (id: string) => {
    setChannelId(null);
    setTasksOpen(false);
    setChatId(id);
  };
  const openChannel = (id: string) => {
    setTasksOpen(false);
    setChannelId(id);
  };
  const openTasks = () => {
    setChannelId(null);
    setTasksOpen(true);
  };
  return {
    pages,
    history,
    chatId,
    channelId,
    setChats,
    setChannels,
    selectChat,
    openChannel,
    openTasks,
  };
}

describe("back and forward", () => {
  it("records chats, channels and pages, and replays them", async () => {
    await createRoot(async (dispose) => {
      const app = setup();
      app.selectChat("a");
      await settle();
      expect(app.pages.location()).toEqual({ id: "chat", threadId: "a" });
      expect(app.history.canGoBack()).toBe(false);

      app.selectChat("b");
      await settle();
      app.openTasks();
      await settle();
      app.openChannel("general");
      await settle();
      app.selectChat("c");
      await settle();

      app.history.back();
      await settle();
      expect(app.channelId()).toBe("general");
      app.history.back();
      await settle();
      expect(app.pages.location()).toEqual({ id: "tasks", projectId: null });
      expect(app.channelId()).toBeNull();
      app.history.back();
      await settle();
      expect([app.pages.location(), app.chatId()]).toEqual([{ id: "chat", threadId: "b" }, "b"]);
      app.history.back();
      await settle();
      expect(app.chatId()).toBe("a");
      expect(app.history.canGoBack()).toBe(false);

      app.history.forward();
      app.history.forward();
      await settle();
      expect(app.pages.location().id).toBe("tasks");
      dispose();
    });
  });

  it("skips chats and channels that were deleted or archived", async () => {
    await createRoot(async (dispose) => {
      const app = setup();
      for (const id of ["a", "b", "c"]) {
        app.selectChat(id);
        await settle();
      }
      app.setChats(["a", "c"]);
      app.history.back();
      await settle();
      expect(app.chatId()).toBe("a");
      expect(app.history.canGoBack()).toBe(false);
      dispose();
    });
  });

  it("waits for the app's next chat when the open one is deleted", async () => {
    await createRoot(async (dispose) => {
      const app = setup();
      app.selectChat("a");
      await settle();
      app.openTasks();
      await settle();
      app.selectChat("b");
      await settle();
      app.setChats(["a", "c"]);
      expect(app.pages.location()).toEqual(CHAT_ROUTE);
      app.selectChat("c");
      await settle();
      expect(app.pages.location()).toEqual({ id: "chat", threadId: "c" });
      app.history.back();
      await settle();
      expect(app.pages.location().id).toBe("tasks");
      dispose();
    });
  });

  it("moves off the open channel when it is deleted", async () => {
    await createRoot(async (dispose) => {
      const app = setup();
      app.selectChat("a");
      await settle();
      app.openChannel("general");
      await settle();
      app.setChannels([]);
      await settle();
      expect([app.pages.location(), app.channelId()]).toEqual([
        { id: "chat", threadId: "a" },
        null,
      ]);
      dispose();
    });
  });

  it("follows the mouse's back and forward buttons", async () => {
    await createRoot(async (dispose) => {
      const app = setup();
      app.selectChat("a");
      await settle();
      app.selectChat("b");
      await settle();
      window.dispatchEvent(new MouseEvent("mouseup", { button: MOUSE_BACK }));
      await settle();
      expect(app.chatId()).toBe("a");
      window.dispatchEvent(new MouseEvent("mouseup", { button: MOUSE_FORWARD }));
      await settle();
      expect(app.chatId()).toBe("b");
      dispose();
    });
  });

  it("goes back with Command-[ and forward with Command-]", async () => {
    await createRoot(async (dispose) => {
      const app = setup();
      app.selectChat("a");
      await settle();
      app.selectChat("b");
      await settle();
      // Mod is Command on the Mac and Control elsewhere.
      const mac = /Mac|iPhone|iPad/.test(navigator.platform);
      const press = (key: string) =>
        window.dispatchEvent(
          new KeyboardEvent("keydown", { key, metaKey: mac, ctrlKey: !mac, bubbles: true }),
        );
      press("[");
      await settle();
      expect(app.chatId()).toBe("a");
      press("]");
      await settle();
      expect(app.chatId()).toBe("b");
      dispose();
    });
  });
});

describe("routes", () => {
  it("names the open place", () => {
    expect(placeRoute("a", null)).toEqual({ id: "chat", threadId: "a" });
    expect(placeRoute("a", "general")).toEqual({ id: "channel", channelId: "general" });
  });

  it("treats only missing chats and channels as gone", () => {
    const none = () => false;
    expect(isGone({ id: "chat", threadId: "x" }, none, none)).toBe(true);
    expect(isGone(CHAT_ROUTE, none, none)).toBe(false);
    expect(isGone({ id: "channel", channelId: "x" }, none, none)).toBe(true);
    expect(isGone({ id: "map" }, none, none)).toBe(false);
  });
});
