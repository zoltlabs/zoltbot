import { expect, test } from "@playwright/test";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { axeViolations, COLOR_SCHEMES, settleColorScheme, shellSession } from "../harness";

/** Pastes plain text into the focused composer, as the clipboard would. */
async function paste(page: import("@playwright/test").Page, text: string) {
  await page.evaluate((words) => {
    const transfer = new DataTransfer();
    transfer.setData("text/plain", words);
    document.activeElement?.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  }, text);
}

test("a paste over 2,000 characters attaches as pasted.txt and can go back inline", async ({
  page,
}) => {
  const fixture = await compareFixture();
  const shell = await shellSession(fixture.daemon);
  try {
    await shell.service.createBot({ profileId: "profile", title: "Release notes" });
    await shell.open(page);
    await page
      .getByRole("complementary", { name: "Bot navigation" })
      .getByRole("button", { name: /^Release notes/ })
      .click();
    const composer = page.getByRole("textbox", { name: "Message Release notes" });
    await composer.click();

    // Exactly 2,000 characters stays in the message.
    await paste(page, "a".repeat(2000));
    await expect(composer).toHaveText("a".repeat(2000));
    await composer.press("ControlOrMeta+a");
    await composer.press("Backspace");

    const long = `${"line of a long log\n".repeat(120)}end`;
    await paste(page, long);
    await expect(page.getByText("Pasted text · 121 lines")).toBeVisible();
    await expect(page.getByText("pasted.txt")).toBeVisible();
    await expect(composer).toHaveText("");

    for (const scheme of COLOR_SCHEMES) {
      await settleColorScheme(page, scheme);
      expect(await axeViolations(page)).toEqual([]);
    }

    await page.getByRole("button", { name: /^Paste as text/ }).click();
    await expect(page.getByText("pasted.txt")).toHaveCount(0);
    await expect(composer).toContainText("line of a long log");
    await expect(composer).toContainText("end");
    expect(shell.errors).toEqual([]);
  } finally {
    await shell.close();
    await fixture.close();
  }
});
