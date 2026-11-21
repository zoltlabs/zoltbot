import { expect, type Page, test } from "@playwright/test";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { axeViolations, shellSession } from "../harness";

/** Set to a folder to save screenshots for review. */
const SHOTS = process.env.ZOLTBOT_SHOTS;

/** The first note of each sound: task finished, message sent. */
const FINISHED = 659.25;
const SENT = 880;

const notes = (page: Page) =>
  page.evaluate(() => (window as unknown as { notes: number[] }).notes.slice());

test("sounds play for a send and for a task finishing in another chat", async ({ page }) => {
  const fixture = await compareFixture();
  const shell = await shellSession(fixture.daemon);
  try {
    // No speakers: record each note's pitch instead of playing it.
    await page.addInitScript(() => {
      const played: number[] = [];
      (window as unknown as { notes: number[] }).notes = played;
      const param = () => ({
        setValueAtTime: (value: number) => value,
        exponentialRampToValueAtTime: () => undefined,
      });
      class FakeAudio {
        currentTime = 0;
        state = "running";
        destination = {};
        createGain() {
          return { gain: param(), connect: (next: unknown) => next };
        }
        createOscillator() {
          return {
            type: "sine",
            frequency: {
              ...param(),
              setValueAtTime: (value: number) => played.push(value),
            },
            connect: (next: unknown) => next,
            start: () => undefined,
            stop: () => undefined,
          };
        }
      }
      (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudio;
    });
    await shell.service.createBot({ profileId: "profile", title: "Release notes" });
    const research = await shell.service.createBot({ profileId: "profile", title: "Research" });
    await shell.open(page);

    await page.getByRole("button", { name: "Open account menu" }).click();
    await page.getByRole("menu").getByRole("menuitem", { name: "Sounds" }).click();
    const dialog = page.getByRole("dialog", { name: "Sounds" });
    for (const name of ["Sounds", "Task finished", "Needs you", "Message sent"])
      await expect(dialog.getByRole("switch", { name, exact: true })).toBeChecked();
    expect(await axeViolations(page)).toEqual([]);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/d2-dialog.png` });
    // Turning the main switch off turns every sound off.
    await dialog.getByRole("switch", { name: "Sounds", exact: true }).click();
    await expect(dialog.getByRole("switch", { name: "Task finished" })).toBeDisabled();
    await dialog.getByRole("switch", { name: "Sounds", exact: true }).click();
    await dialog.getByRole("button", { name: "Done" }).click();

    await page
      .getByRole("complementary", { name: "Bot navigation" })
      .getByRole("button", { name: /^Release notes/ })
      .click();
    const composer = page.getByRole("textbox", { name: "Message Release notes" });
    await composer.click();
    const before = (await notes(page)).length;
    await composer.pressSequentially("Summarize the release");
    await composer.press("Enter");
    await expect.poll(async () => (await notes(page)).slice(before)).toContain(SENT);
    await expect(page.getByText("First answer").last()).toBeVisible({ timeout: 15_000 });
    // The owner watched that reply arrive: it makes no sound.
    if (await page.evaluate(() => document.hasFocus()))
      expect((await notes(page)).slice(before)).not.toContain(FINISHED);

    // A task finishing in a chat that isn't open does.
    const quiet = (await notes(page)).length;
    await shell.service.sendMessage({
      botId: research.id,
      text: "Summarize the release",
      attachmentDraftIds: [],
    });
    await expect
      .poll(async () => (await notes(page)).slice(quiet), { timeout: 15_000 })
      .toContain(FINISHED);
    expect(shell.errors).toEqual([]);
  } finally {
    await shell.close();
    await fixture.close();
  }
});
