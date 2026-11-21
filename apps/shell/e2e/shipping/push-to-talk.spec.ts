import { expect, test } from "@playwright/test";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { axeViolations, shellSession } from "../harness";

/** Set to a folder to save screenshots for review. */
const SHOTS = process.env.ZOLTBOT_SHOTS;

test("holding the push-to-talk key dictates into the composer and sends on release", async ({
  page,
}) => {
  const fixture = await compareFixture();
  const shell = await shellSession(fixture.daemon);
  try {
    // No microphone: the stub "hears" a phrase while listening and finishes it on stop.
    await page.addInitScript(() => {
      const listeners = new Set<(event: unknown) => void>();
      let session = "";
      let n = 0;
      const emit = (event: unknown) => {
        for (const listener of listeners) listener(event);
      };
      const status = {
        available: true,
        onDevice: true,
        locale: "en-US",
        microphone: "authorized",
        speech: "authorized",
      };
      const dictation = {
        status: async () => status,
        requestPermission: async () => status,
        start: async () => {
          session = `s${++n}`;
          setTimeout(() => emit({ sessionId: session, kind: "partial", text: "Ship the" }), 20);
          return { sessionId: session };
        },
        sendAudio: () => undefined,
        stop: async (id: string) => {
          emit({ sessionId: id, kind: "final", text: "Ship the release" });
          emit({ sessionId: id, kind: "stopped" });
        },
        cancel: async () => undefined,
        onEvent: (listener: (event: unknown) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
      let api: { dictation?: unknown } | undefined;
      Object.defineProperty(window, "openbot", {
        configurable: true,
        get: () => api,
        set: (value) => {
          api = value;
          if (api) api.dictation = dictation;
        },
      });
    });
    await shell.service.createBot({ profileId: "profile", title: "Release notes" });
    await shell.open(page);

    // Right Option, sending on release. (Headless keyboards can't press Fn.)
    await page.getByRole("button", { name: "Open account menu" }).click();
    await page.getByRole("menu").getByRole("menuitem", { name: "Voice" }).click();
    const dialog = page.getByRole("dialog", { name: "Voice" });
    await dialog.getByRole("button", { name: /^Push to talk key/ }).click();
    await page.getByRole("option", { name: "Right Option" }).click();
    await dialog.getByRole("switch", { name: "Send when released" }).check();
    expect(await axeViolations(page)).toEqual([]);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/o3-settings.png` });
    await dialog.getByRole("button", { name: "Done" }).click();

    await page
      .getByRole("complementary", { name: "Bot navigation" })
      .getByRole("button", { name: /^Release notes/ })
      .click();
    const composer = page.getByRole("textbox", { name: "Message Release notes" });
    await expect(composer).toBeVisible();

    // A tap does nothing.
    await page.keyboard.down("AltRight");
    await page.keyboard.up("AltRight");
    await expect(composer).toHaveText("");

    // Hold, talk, let go: the words land in the composer and send.
    await page.keyboard.down("AltRight");
    await expect(composer).toHaveText("Ship the");
    await page.waitForTimeout(300);
    await page.keyboard.up("AltRight");
    await expect(page.locator(".message-entry-user").getByText("Ship the release")).toBeVisible();
    await expect(composer).toHaveText("");
    expect(shell.errors).toEqual([]);
  } finally {
    await shell.close();
    await fixture.close();
  }
});
