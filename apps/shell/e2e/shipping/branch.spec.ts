import { expect, type Page, test } from "@playwright/test";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { axeViolations, COLOR_SCHEMES, settleColorScheme, shellSession } from "../harness";

async function send(page: Page, chat: string, text: string) {
  const composer = page.getByRole("textbox", { name: `Message ${chat}` });
  await composer.click();
  await composer.pressSequentially(text);
  await composer.press("Enter");
}

async function messageMenu(page: Page, text: string) {
  const entry = page.locator("article.message-entry").filter({ hasText: text }).last();
  await entry.hover();
  await entry.getByRole("button", { name: "More message actions" }).click();
  return page.getByRole("menu");
}

test("a chat branches from an answer and edits a sent message into a new branch", async ({
  page,
}) => {
  const fixture = await compareFixture();
  const shell = await shellSession(fixture.daemon);
  try {
    await shell.service.createBot({ profileId: "profile", title: "Release notes" });
    await shell.open(page);
    const sidebar = page.getByRole("complementary", { name: "Bot navigation" });
    await sidebar.getByRole("button", { name: /^Release notes/ }).click();
    await send(page, "Release notes", "Summarize the release");
    await expect(page.getByText("First answer").last()).toBeVisible({ timeout: 15_000 });

    // Branch from the answer.
    const menu = await messageMenu(page, "First answer");
    await menu.getByRole("menuitem", { name: "Branch from here" }).click();
    const dialog = page.getByRole("dialog", { name: "Branch from this message" });
    const confirm = dialog.getByRole("button", { name: "Branch", exact: true });
    await expect(confirm).toBeEnabled({ timeout: 15_000 });
    for (const scheme of COLOR_SCHEMES) {
      await settleColorScheme(page, scheme);
      expect(await axeViolations(page)).toEqual([]);
    }
    await confirm.click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });
    const banner = page.getByText("Branched from");
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByRole("textbox", { name: "Message Release notes (branch)" }),
    ).toBeVisible();

    // The banner links back, and the original answer lists its branch.
    await page.getByRole("button", { name: "Release notes", exact: true }).click();
    const count = page.getByRole("button", { name: "1 branch" });
    await expect(count).toBeVisible({ timeout: 15_000 });

    // Edit the sent message into a second branch; the text becomes its draft.
    const own = await messageMenu(page, "Summarize the release");
    await own.getByRole("menuitem", { name: "Edit in new branch" }).click();
    const edit = page.getByRole("dialog", { name: "Edit in a new branch" });
    const text = edit.getByRole("textbox", { name: "Message" });
    await expect(text).toHaveValue("Summarize the release");
    await text.fill("Summarize the release in one line");
    const send2 = edit.getByRole("button", { name: "Branch and edit" });
    await expect(send2).toBeEnabled({ timeout: 15_000 });
    await send2.click();
    await expect(edit).toBeHidden({ timeout: 15_000 });
    // Nothing comes before the first message, so its edit starts a new chat with the text.
    await expect(page.getByRole("textbox", { name: /^Message / })).toHaveText(
      "Summarize the release in one line",
    );
    expect(shell.errors).toEqual([]);
  } finally {
    await shell.close();
    await fixture.close();
  }
});
