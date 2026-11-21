import { expect, test } from "@playwright/test";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { axeViolations, COLOR_SCHEMES, settleColorScheme, shellSession } from "../harness";

/** Set to a folder to save screenshots for review. */
const SHOTS = process.env.ZOLTBOT_SHOTS;

type Spoken = { text: string; rate: number }[];

test("a reply is read aloud from its menu, and Voice settings set the reading", async ({
  page,
}) => {
  const fixture = await compareFixture();
  const shell = await shellSession(fixture.daemon);
  try {
    // Nothing plays out loud: speechSynthesis records what it was asked to say.
    await page.addInitScript(() => {
      const spoken: { text: string; rate: number }[] = [];
      let current: { onend?: () => void; onerror?: (event: { error: string }) => void } | null;
      (window as unknown as { __spoken: typeof spoken }).__spoken = spoken;
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
            spoken.push({ text: utterance.text, rate: utterance.rate });
            current = utterance;
          },
          cancel: () => {
            current?.onerror?.({ error: "interrupted" });
            current = null;
          },
          getVoices: () => [{ voiceURI: "ava", name: "Ava", lang: "en-US", default: true }],
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
        },
      });
    });
    await shell.service.createBot({ profileId: "profile", title: "Release notes" });
    await shell.open(page);
    const spoken = () =>
      page.evaluate(() => (window as unknown as { __spoken: Spoken }).__spoken.map((s) => s.text));

    // Voice settings from the account menu: read new replies, at 1.5×.
    await page.getByRole("button", { name: "Open account menu" }).click();
    await page.getByRole("menu").getByRole("menuitem", { name: "Voice" }).click();
    const dialog = page.getByRole("dialog", { name: "Voice" });
    await expect(dialog).toBeVisible();
    for (const scheme of COLOR_SCHEMES) {
      await settleColorScheme(page, scheme);
      expect(await axeViolations(page)).toEqual([]);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/o1-voice-${scheme}.png` });
    }
    await dialog.getByRole("switch", { name: "Read new replies aloud" }).check();
    await dialog.getByRole("button", { name: /^Speed/ }).click();
    await page.getByRole("option", { name: "1.5×" }).click();
    // ElevenLabs asks for a key and says where messages go.
    await dialog.getByRole("button", { name: /^Engine/ }).click();
    await page.getByRole("option", { name: "ElevenLabs" }).click();
    await expect(dialog.getByLabel("ElevenLabs key")).toBeVisible();
    await expect(dialog.getByText("Messages are sent to ElevenLabs.")).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/o1-voice-elevenlabs.png` });
    expect(await axeViolations(page)).toEqual([]);
    await dialog.getByRole("button", { name: /^Engine/ }).click();
    await page.getByRole("option", { name: "This Mac" }).click();
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(dialog).toHaveCount(0);

    // The new reply is read as it finishes.
    await page
      .getByRole("complementary", { name: "Bot navigation" })
      .getByRole("button", { name: /^Release notes/ })
      .click();
    const composer = page.getByRole("textbox", { name: "Message Release notes" });
    await composer.click();
    await composer.pressSequentially("Summarize the release");
    await composer.press("Enter");
    const answer = page.getByText("First answer").last();
    await expect(answer).toBeVisible({ timeout: 15_000 });
    await expect.poll(spoken).toEqual([expect.stringContaining("First answer")]);
    const rate = await page.evaluate(
      () => (window as unknown as { __spoken: Spoken }).__spoken[0]?.rate,
    );
    expect(rate).toBe(1.5);

    // Stop reading sits on the message while it's read.
    const entry = page.locator(".message-entry-bot").filter({ has: answer });
    const toolbar = entry.getByRole("toolbar", { name: "Agent message actions" });
    await toolbar.getByRole("button", { name: "Stop reading" }).click();
    await expect(toolbar.getByRole("button", { name: "Stop reading" })).toHaveCount(0);

    // Read aloud from the menu reads it again.
    await answer.hover();
    await toolbar.getByRole("button", { name: "More message actions" }).click();
    await page.getByRole("menu").getByRole("menuitem", { name: "Read aloud" }).click();
    await expect.poll(async () => (await spoken()).length).toBe(2);
    await expect(toolbar.getByRole("button", { name: "Stop reading" })).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/o1-reading.png` });
    expect(await axeViolations(page)).toEqual([]);
    expect(shell.errors).toEqual([]);
  } finally {
    await shell.close();
    await fixture.close();
  }
});
