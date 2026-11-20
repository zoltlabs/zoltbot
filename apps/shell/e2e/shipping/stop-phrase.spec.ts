import { expect, type Page, test } from "@playwright/test";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { shellSession } from "../harness";

async function send(page: Page, text: string) {
  const composer = page.getByRole("textbox", { name: "Message Release notes" });
  await composer.click();
  await composer.pressSequentially(text);
  await composer.press("Enter");
}

test("sending just stop while the agent works stops the turn", async ({ page }) => {
  const fixture = await compareFixture();
  const shell = await shellSession(fixture.daemon);
  try {
    await shell.service.createBot({ profileId: "profile", title: "Release notes" });
    await shell.open(page);
    const sidebar = page.getByRole("complementary", { name: "Bot navigation" });
    await sidebar.getByRole("button", { name: /^Release notes/ }).click();

    // The fake takes 3 seconds to answer "Take time".
    await send(page, "Take time to read the notes");
    await expect(page.getByRole("button", { name: "Stop agent" })).toBeVisible({ timeout: 15_000 });
    await send(page, "Stop.");
    await expect(page.getByText("Stopped", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Stop agent" })).toBeHidden({ timeout: 10_000 });
    const native = [...fixture.natives.values()][0];
    expect(native?.interrupted).toBe(1);
    expect(native?.received).toHaveLength(1);

    // With nothing running, "stop" is an ordinary message.
    await send(page, "stop");
    await expect.poll(() => native?.received.length, { timeout: 15_000 }).toBe(2);
    expect(native?.interrupted).toBe(1);
    expect(shell.errors).toEqual([]);
  } finally {
    await shell.close();
    await fixture.close();
  }
});
