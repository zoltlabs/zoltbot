import { expect, test } from "@playwright/test";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { axeViolations, shellSession } from "../harness";

/** Set to a folder to save screenshots for review. */
const SHOTS = process.env.ZOLTBOT_SHOTS;

test("the agent dock shows a working agent, its last reply and sends from a mini chat", async ({
  page,
}) => {
  const fixture = await compareFixture();
  const shell = await shellSession(fixture.daemon);
  try {
    const research = await shell.service.createBot({ profileId: "profile", title: "Research" });
    await shell.service.sendMessage({
      botId: research.id,
      text: "Summarize the release",
      attachmentDraftIds: [],
    });
    await expect
      .poll(async () => (await shell.service.readConversation(research.id)).messages.length, {
        timeout: 15_000,
      })
      .toBeGreaterThan(1);

    // Main keeps the dock's state; here the test plays main, with Research working.
    await page.addInitScript((botId) => {
      const listeners = new Set<(state: unknown) => void>();
      let state = {
        position: "right",
        agents: [
          {
            id: botId,
            name: "Research",
            avatarShape: "blob",
            avatarColor: "cyan",
            working: true,
            waiting: false,
          },
        ],
        needsYou: 1,
        expanded: null as string | null,
      };
      const opened: string[] = [];
      (window as unknown as { opened: string[] }).opened = opened;
      const dock = {
        getState: async () => state,
        onState: (listener: (state: unknown) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        expand: async (id: string | null) => {
          state = { ...state, expanded: id };
          for (const listener of listeners) listener(state);
        },
        openChat: async (id: string) => {
          opened.push(id);
        },
        onShowChat: () => () => undefined,
      };
      let api: { dock?: unknown } | undefined;
      Object.defineProperty(window, "openbot", {
        configurable: true,
        get: () => api,
        set: (value) => {
          api = value;
          if (api) api.dock = dock;
        },
      });
    }, research.id);
    // The size of the dock's window with its mini chat open.
    await page.setViewportSize({ width: 380, height: 360 });
    await shell.open(page, "dock.html");

    const avatar = page.getByRole("button", { name: "Research, working" });
    await expect(avatar).toBeVisible();
    // The window is see-through: only the bar and the chat draw.
    expect(
      await page.evaluate(() =>
        [document.documentElement, document.body].map(
          (node) => getComputedStyle(node).backgroundColor,
        ),
      ),
    ).toEqual(["rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)"]);
    await expect(page.getByRole("status")).toContainText("1 needs you");
    await avatar.click();
    await expect(page.getByText("First answer")).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/d4-dock.png` });

    const composer = page.getByRole("textbox", { name: "Message Research" });
    // Opening the mini chat puts the cursor in it.
    await expect(composer).toBeFocused();
    await composer.fill("Add the date");
    await composer.press("Enter");
    await expect(composer).toHaveValue("");
    await expect
      .poll(async () =>
        (await shell.service.readConversation(research.id)).messages.some(
          (message) => message.text === "Add the date",
        ),
      )
      .toBe(true);

    // A second click on the open agent opens its full chat.
    await avatar.click();
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { opened: string[] }).opened))
      .toEqual([research.id]);
    expect(shell.errors).toEqual([]);
  } finally {
    await shell.close();
    await fixture.close();
  }
});
