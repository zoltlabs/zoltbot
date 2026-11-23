import { expect, test } from "@playwright/test";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { shellSession } from "../harness";

test("the To: picker lists every agent and starts a chat with the one you choose", async ({
  page,
}) => {
  const fixture = await compareFixture();
  const shell = await shellSession(fixture.daemon);
  try {
    await shell.open(page);
    await page.getByRole("button", { name: "New agent" }).click();
    const list = page.getByRole("listbox", { name: "Agents" });
    await expect(list.getByRole("option", { name: "Third" })).toBeVisible();
    await expect(list.getByRole("option", { name: "Fourth" })).toBeVisible();

    await page.getByRole("combobox", { name: "To:" }).fill("four");
    await expect(list.getByRole("option", { name: "Third" })).toHaveCount(0);
    await list.getByRole("option", { name: "Fourth" }).click();

    await expect(page.getByRole("heading", { level: 1, name: "Fourth" })).toBeVisible();
    expect(shell.errors).toEqual([]);
  } finally {
    await shell.close();
    await fixture.close();
  }
});
