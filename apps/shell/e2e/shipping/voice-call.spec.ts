import { expect, test } from "@playwright/test";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { axeViolations, COLOR_SCHEMES, settleColorScheme, shellSession } from "../harness";

/** Set to a folder to save screenshots for review. */
const SHOTS = process.env.ZOLTBOT_SHOTS;

type Stubs = { spoken: string[]; cancelled: string[]; say(text: string): void };

test("a call sends what was said, reads the reply, stops when talked over and logs itself", async ({
  page,
}) => {
  const fixture = await compareFixture();
  const shell = await shellSession(fixture.daemon);
  try {
    // No microphone and no speaker: dictation hears what the test says, speech records what it reads.
    await page.addInitScript(() => {
      const listeners = new Set<(event: unknown) => void>();
      const stubs = { spoken: [] as string[], cancelled: [] as string[], session: "", n: 0 };
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
          stubs.session = `s${++stubs.n}`;
          return { sessionId: stubs.session };
        },
        sendAudio: () => undefined,
        stop: async () => undefined,
        cancel: async (id?: string) => {
          stubs.cancelled.push(id ?? "");
        },
        onEvent: (listener: (event: unknown) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
      (window as unknown as { __call: unknown }).__call = Object.assign(stubs, {
        say: (text: string) => {
          for (const listener of listeners)
            listener({ sessionId: stubs.session, kind: "partial", text });
        },
      });
      // The bridge sets window.openbot after this script; swap in the stub as it does.
      let api: { dictation?: unknown } | undefined;
      Object.defineProperty(window, "openbot", {
        configurable: true,
        get: () => api,
        set: (value) => {
          api = value;
          if (api) api.dictation = dictation;
        },
      });
      let current: { onerror?: (event: { error: string }) => void } | null = null;
      class Utterance {
        rate = 1;
        voice = null;
        lang = "";
        onend?: () => void;
        onerror?: (event: { error: string }) => void;
        constructor(public text: string) {}
      }
      Object.defineProperty(window, "SpeechSynthesisUtterance", { value: Utterance });
      Object.defineProperty(window, "speechSynthesis", {
        value: {
          speak: (utterance: Utterance) => {
            stubs.spoken.push(utterance.text);
            current = utterance;
          },
          cancel: () => {
            current?.onerror?.({ error: "interrupted" });
            current = null;
          },
          getVoices: () => [],
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
        },
      });
    });
    await shell.service.createBot({ profileId: "profile", title: "Release notes" });
    await shell.open(page);
    const stubs = () => page.evaluate(() => (window as unknown as { __call: Stubs }).__call);
    const say = (text: string) =>
      page.evaluate((words) => (window as unknown as { __call: Stubs }).__call.say(words), text);

    // Start a call from the agent menu.
    const row = page
      .getByRole("complementary", { name: "Bot navigation" })
      .getByRole("button", { name: /^Release notes/ });
    await row.click({ button: "right" });
    await page.getByRole("menu").getByRole("menuitem", { name: "Start call" }).click();
    const bar = page.getByRole("region", { name: "Call" });
    await expect(bar).toBeVisible();
    await expect(bar.getByText("Listening")).toBeVisible();
    // axeViolations checks both themes itself.
    expect(await axeViolations(page)).toEqual([]);
    if (SHOTS)
      for (const scheme of COLOR_SCHEMES) {
        await settleColorScheme(page, scheme);
        await page.screenshot({ path: `${SHOTS}/o2-listening-${scheme}.png` });
      }

    // A pause sends what was said; the guidance isn't shown, and the reply is read aloud.
    await say("Summarize the release");
    const sent = page.locator(".message-entry-user").getByText("Summarize the release");
    await expect(sent).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("This is a voice call")).toHaveCount(0);
    await expect(page.getByText("First answer").last()).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(async () => (await stubs()).spoken)
      .toEqual([expect.stringContaining("First answer")]);
    await expect(bar.getByText("Speaking")).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/o2-speaking.png` });

    // Its own echo doesn't stop it; talking over it does.
    await say("First answer");
    await expect(bar.getByText("Speaking")).toBeVisible();
    await say("hold on one more thing");
    await expect(bar.getByText("Listening")).toBeVisible();

    // Mute, then End: the call shows in the chat with its length.
    await bar.getByRole("button", { name: "Mute" }).click();
    await expect(
      page.locator(".message-entry-user").getByText("hold on one more thing"),
    ).toBeVisible();
    await expect(bar.getByRole("button", { name: "Unmute" })).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/o2-muted.png` });
    await bar.getByRole("button", { name: "End" }).click();
    await expect(bar).toHaveCount(0);
    await expect(
      page.locator(".manager-notice").filter({ hasText: /Call\s*·\s*\d+:\d\d/ }),
    ).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/o2-notice.png` });

    // ⌘⇧V starts the next call in the open chat.
    await page.getByRole("textbox", { name: "Message Release notes" }).click();
    await page.keyboard.press("ControlOrMeta+Shift+V");
    await expect(bar).toBeVisible();
    await page.keyboard.press("ControlOrMeta+Shift+V");
    await expect(bar).toHaveCount(0);
    expect(shell.errors).toEqual([]);
  } finally {
    await shell.close();
    await fixture.close();
  }
});
