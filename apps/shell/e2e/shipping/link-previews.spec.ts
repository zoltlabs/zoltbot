import { expect, test } from "@playwright/test";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { axeViolations, COLOR_SCHEMES, settleColorScheme, shellSession } from "../harness";

// A 1×1 PNG, standing in for a page's picture.
const PICTURE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("a link in a message gets a card, and the owner can turn cards off", async ({ page }) => {
  const fixture = await compareFixture();
  const shell = await shellSession(fixture.daemon);
  const setting = async () =>
    (
      (await shell.service.client.call("settings.get", {})) as { key: string; value: unknown }[]
    ).find((row) => row.key === "links.preview")?.value;
  try {
    // The daemon serves link.preview, and only for links in a message.
    await expect(
      shell.service.client.call(
        "link.preview",
        { threadId: "missing", itemId: "missing", url: "https://example.com/" },
        "e2e-link-check",
      ),
    ).rejects.toThrow("link_not_in_message");

    await shell.service.createBot({ profileId: "profile", title: "Research" });
    await shell.open(page);
    // Pages aren't fetched in tests: the card comes from here.
    await page.evaluate((picture) => {
      const links = (
        window as unknown as { openbot: { links: { preview: (input: unknown) => unknown } } }
      ).openbot.links;
      links.preview = async (input) => {
        const { url } = input as { url: string };
        return url.includes("guide")
          ? {
              url,
              title: "Field guide to owls",
              siteName: "example.com",
              description: "Where they nest and what they eat.",
              image: picture,
            }
          : null;
      };
    }, PICTURE);
    await page
      .getByRole("complementary", { name: "Bot navigation" })
      .getByRole("button", { name: /^Research/ })
      .click();

    const composer = page.getByRole("textbox", { name: "Message Research" });
    await composer.click();
    await composer.pressSequentially(
      "Read https://example.com/guide and https://example.com/none and https://example.com/third",
    );
    await composer.press("Enter");

    const card = page.getByRole("link", { name: /Field guide to owls/ });
    await expect(card).toBeVisible();
    await expect(card).toContainText("example.com");
    await expect(card.locator("img")).toHaveAttribute("src", PICTURE);
    // A link the page has no card for shows nothing extra.
    await expect(page.locator(".link-card")).toHaveCount(1);
    for (const scheme of COLOR_SCHEMES) {
      await settleColorScheme(page, scheme);
      expect(await axeViolations(page)).toEqual([]);
    }

    await page.getByRole("button", { name: "Open account menu" }).click();
    const item = page
      .getByRole("menu")
      .getByRole("menuitemcheckbox", { name: "Show link previews" });
    await expect(item).toBeChecked();
    await item.click();
    await expect(card).toBeHidden();
    await expect.poll(setting).toBe(false);
    expect(shell.errors).toEqual([]);
  } finally {
    await shell.close();
    await fixture.close();
  }
});
