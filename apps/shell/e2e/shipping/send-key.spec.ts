import { expect, test } from "@playwright/test";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { axeViolations, shellSession } from "../harness";

test("the owner can send with ⌘ Enter so Enter adds a line", async ({ page }) => {
  const fixture = await compareFixture();
  const shell = await shellSession(fixture.daemon);
  try {
    await shell.service.createBot({ profileId: "profile", title: "Release notes" });
    await shell.open(page);
    await page
      .getByRole("complementary", { name: "Bot navigation" })
      .getByRole("button", { name: /^Release notes/ })
      .click();

    await page.getByRole("button", { name: "Open account menu" }).click();
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitemradio", { name: "Send with Enter" })).toBeChecked();
    expect(await axeViolations(page)).toEqual([]);
    await menu.getByRole("menuitemradio", { name: "Send with ⌘ Enter" }).click();
    await expect
      .poll(() =>
        page.evaluate(
          async () =>
            (
              await (
                window as unknown as {
                  openbot: { preferences: { get(): Promise<{ sendKey: string }> } };
                }
              ).openbot.preferences.get()
            ).sendKey,
        ),
      )
      .toBe("mod-enter");

    const composer = page.getByRole("textbox", { name: "Message Release notes" });
    await composer.click();
    await composer.pressSequentially("first line");
    await composer.press("Enter");
    await composer.pressSequentially("second line");
    await expect(composer).toContainText("first line");
    await expect(composer).toContainText("second line");

    await composer.press("ControlOrMeta+Enter");
    await expect(composer).toHaveText("");
    const sent = page
      .getByLabel("Conversation")
      .locator(".message-copy", { hasText: "second line" });
    await expect(sent).toBeVisible();
    // Enter made a real line break in the sent message.
    expect(await sent.evaluate((node) => node.innerText)).toMatch(/first line\s*\n\s*second line/);
    expect(shell.errors).toEqual([]);
  } finally {
    await shell.close();
    await fixture.close();
  }
});
