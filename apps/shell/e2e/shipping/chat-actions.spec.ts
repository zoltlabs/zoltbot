import { expect, test } from "@playwright/test";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { axeViolations, shellSession } from "../harness";

/**
 * Ported from tests/shipping/chat-actions.spec.ts. The shell's agent rows have a context menu
 * with Edit agent and Delete agent; pinning, unread marks, archive and Quick Chat rows are not in
 * the shell yet (see NOT-PORTED.md).
 */
test("agent row context menu renames and deletes, from the mouse and the keyboard", async ({
  page,
}) => {
  const fixture = await compareFixture();
  const shell = await shellSession(fixture.daemon);
  try {
    const alpha = await shell.service.createBot({ profileId: "profile", title: "Alpha chat" });
    const beta = await shell.service.createBot({ profileId: "profile", title: "Beta chat" });
    await shell.open(page);
    const sidebar = page.getByRole("complementary", { name: "Bot navigation" });
    const alphaRow = sidebar.getByRole("button", { name: /Alpha chat/ });
    const betaRow = sidebar.getByRole("button", { name: /Beta chat/ });
    await expect(alphaRow).toBeVisible();
    await expect(betaRow).toBeVisible();

    // Right-click opens the menu; Edit agent opens settings where the name is saved on blur.
    await alphaRow.click({ button: "right" });
    const menu = page.getByRole("menu", { name: "Agent actions" });
    await expect(menu.getByRole("menuitem", { name: "Edit agent" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Delete agent" })).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
    await menu.getByRole("menuitem", { name: "Edit agent" }).click();
    await expect(menu).toHaveCount(0);
    const name = page.getByRole("textbox", { name: "Agent name" });
    await name.fill("Alpha renamed");
    await name.blur();
    await expect(sidebar.getByRole("button", { name: /Alpha renamed/ })).toBeVisible();
    await expect
      .poll(() => fixture.daemon.store.record("thread", alpha.id)?.title)
      .toBe("Alpha renamed");

    // Shift+F10 opens the same menu from the keyboard; Cancel keeps the agent.
    await betaRow.focus();
    await page.keyboard.press("Shift+F10");
    await menu.getByRole("menuitem", { name: "Delete agent" }).click();
    const confirm = page.getByRole("alertdialog", { name: "Delete Beta chat?" });
    await expect(confirm).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
    await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(confirm).toHaveCount(0);
    await expect(betaRow).toBeVisible();

    await betaRow.click({ button: "right" });
    await menu.getByRole("menuitem", { name: "Delete agent" }).click();
    await confirm.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(betaRow).toHaveCount(0);
    await expect.poll(() => fixture.daemon.store.record("thread", beta.id)?.archived).toBe(true);
    expect(shell.errors).toEqual([]);
  } finally {
    await shell.close();
    await fixture.close();
  }
});
