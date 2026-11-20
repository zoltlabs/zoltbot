import { expect, type Page, test } from "@playwright/test";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { axeViolations, COLOR_SCHEMES, settleColorScheme, shellSession } from "../harness";

async function send(page: Page, text: string) {
  const composer = page.getByRole("textbox", { name: "Message Release notes" });
  await composer.click();
  await composer.pressSequentially(text);
  await composer.press("Enter");
}

const said = (input: unknown) =>
  (input as { type: string; text?: string }[]).map((part) => part.text ?? "").join("");

test("queued messages can be reordered and sent now", async ({ page }) => {
  const fixture = await compareFixture();
  const shell = await shellSession(fixture.daemon);
  try {
    await shell.service.createBot({ profileId: "profile", title: "Release notes" });
    await shell.open(page);
    const sidebar = page.getByRole("complementary", { name: "Bot navigation" });
    await sidebar.getByRole("button", { name: /^Release notes/ }).click();

    // The fake takes 3 seconds to answer "Take time", so the next three wait in the queue.
    await send(page, "Take time to read the notes");
    await expect(page.getByRole("button", { name: "Stop agent" })).toBeVisible({ timeout: 15_000 });
    await send(page, "Second");
    await send(page, "Third");
    await send(page, "Fourth");
    const queue = page.getByRole("region", { name: /^\d+ queued/ });
    await expect(queue.getByRole("heading", { name: "3 queued" })).toBeVisible();
    for (const scheme of COLOR_SCHEMES) {
      await settleColorScheme(page, scheme);
      expect(await axeViolations(page)).toEqual([]);
    }

    // Alt+↓ moves Second below Third; the row keeps focus.
    const grip = queue.getByRole("button", { name: "Move Second" });
    await grip.focus();
    await page.keyboard.press("Alt+ArrowDown");
    await expect(queue.getByRole("listitem")).toHaveText(["Third", "Second", "Fourth"]);
    await expect(queue.getByRole("button", { name: "Move Second" })).toBeFocused();

    // Send now steers Fourth into the running turn.
    await queue.getByRole("button", { name: "Actions for Fourth" }).click();
    await page.getByRole("menuitem", { name: /Send now/ }).click();
    await expect(queue.getByRole("listitem")).toHaveText(["Third", "Second"]);

    const native = [...fixture.natives.values()][0];
    await expect
      .poll(() => native?.received.map(said), { timeout: 20_000 })
      .toEqual(["Take time to read the notes", "Fourth", "Third", "Second"]);
    expect(shell.errors).toEqual([]);
  } finally {
    await shell.close();
    await fixture.close();
  }
});
