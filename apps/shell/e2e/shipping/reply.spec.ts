import { expect, test } from "@playwright/test";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { axeViolations, shellSession } from "../harness";

test("a reply sends its quote to the agent and keeps it above the words", async ({ page }) => {
  const fixture = await compareFixture();
  const shell = await shellSession(fixture.daemon);
  try {
    await shell.service.createBot({ profileId: "profile", title: "Release notes" });
    await shell.open(page);
    const sidebar = page.getByRole("complementary", { name: "Bot navigation" });
    await sidebar.getByRole("button", { name: /^Release notes/ }).click();
    const composer = page.getByRole("textbox", { name: "Message Release notes" });
    await composer.click();
    await composer.pressSequentially("Summarize the release");
    await composer.press("Enter");
    const answer = page.getByText("First answer").last();
    await expect(answer).toBeVisible({ timeout: 15_000 });

    // Wait for the finished answer's actions before opening its menu.
    const entry = page.locator(".message-entry-bot").filter({ has: answer });
    await answer.hover();
    await expect(entry.getByRole("toolbar", { name: "Agent message actions" })).toBeVisible();
    await answer.click({ button: "right" });
    await page
      .getByRole("menu", { name: "Message actions" })
      .getByRole("menuitem", { name: "Reply" })
      .click();
    await expect(page.getByText("Replying to Agent")).toBeVisible();
    await composer.click();
    await composer.pressSequentially("Ship it?");
    await composer.press("Enter");

    // The daemon keeps the quote in the sent text; the transcript shows it as reply context.
    const sent = page.locator(".message-entry-user").filter({ hasText: "Ship it?" }).last();
    await expect(sent.locator(".message-reply-context")).toContainText("First answer", {
      timeout: 15_000,
    });
    await expect(sent.locator(".message-copy")).toHaveText("Ship it?");
    // The agent received the quote ahead of the reply.
    const received = [...fixture.natives.values()].flatMap((native) => native.received);
    expect(JSON.stringify(received.at(-1))).toContain("> First answer\\n\\nShip it?");
    // Check accessibility once the agent's second answer has finished.
    await expect(page.locator(".message-entry-bot")).toHaveCount(2, { timeout: 15_000 });
    await expect(page.locator(".bot-bubble-streaming")).toHaveCount(0, { timeout: 15_000 });
    expect(await axeViolations(page)).toEqual([]);
    expect(shell.errors).toEqual([]);
  } finally {
    await shell.close();
    await fixture.close();
  }
});
