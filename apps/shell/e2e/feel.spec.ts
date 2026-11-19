import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { compareFixture } from "../../../tools/fakes/src/compare-fixture";
import { DaemonClient } from "../src/zolt/daemon-client";
import { ZoltService } from "../src/zolt/zolt-service";
import { openShell } from "./bridge";

/**
 * Feel check: the built renderer in headless Chromium, talking to a real daemon through the same
 * handlers Electron main registers. Each step records how long the page took to show the result.
 */
test("switching, sending, streaming and answering feel immediate", async ({ page }) => {
  const fixture = await compareFixture();
  const client = new DaemonClient(async () => ({
    url: fixture.daemon.url,
    token: fixture.daemon.token,
  }));
  const service = new ZoltService(client, mkdtempSync(join(tmpdir(), "zoltbot-shell-feel-")));
  const timings: Record<string, number> = {};
  try {
    await service.initialize();
    const research = await service.createBot({ profileId: "profile" });
    await service.updateBot({ botId: research.id, name: "Research" });
    const release = await service.createBot({ profileId: "profile" });
    await service.updateBot({ botId: release.id, name: "Release notes" });

    await openShell(page, service);
    await expect(page.getByRole("button", { name: /Release notes/ }).first()).toBeVisible();

    timings.switchChat = await timed(page, async () => {
      await page
        .getByRole("button", { name: /Research/ })
        .first()
        .click();
      await expect(page.getByRole("textbox", { name: "Message Research" })).toBeVisible();
    });
    timings.switchBack = await timed(page, async () => {
      await page
        .getByRole("button", { name: /Release notes/ })
        .first()
        .click();
      await expect(page.getByRole("textbox", { name: "Message Release notes" })).toBeVisible();
    });

    const composer = page.getByRole("textbox", { name: "Message Release notes" });
    await composer.click();
    timings.typeToScreen = await timed(page, async () => {
      await composer.pressSequentially("Summarize the release");
      await expect(composer).toHaveText("Summarize the release");
    });

    const sentAt = Date.now();
    await composer.press("Enter");
    await expect(page.getByText("Summarize the release").last()).toBeVisible();
    timings.sendToBubble = Date.now() - sentAt;
    await expect(composer).toHaveText("");
    await expect(page.getByText("First answer").last()).toBeVisible({ timeout: 15_000 });
    timings.sendToReply = Date.now() - sentAt;

    await composer.click();
    await composer.pressSequentially("Ask me a question");
    const askedAt = Date.now();
    await composer.press("Enter");
    await expect(page.getByText("Choose an approach").last()).toBeVisible({ timeout: 15_000 });
    timings.questionShown = Date.now() - askedAt;
    timings.answerCleared = await timed(page, async () => {
      await page
        .getByRole("button", { name: /Use this approach/ })
        .first()
        .click();
      await page.getByRole("button", { name: "Send answer" }).click();
      await expect(page.getByText("Choose an approach")).toHaveCount(0, { timeout: 15_000 });
    });

    timings.turnSettled = await timed(page, async () => {
      await expect(
        page.getByText("Working", { exact: true }).filter({ visible: true }),
      ).toHaveCount(0, { timeout: 15_000 });
    });
    await expect(page.getByRole("button", { name: "Agent model: Default model" })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("after-answer.png") });

    timings.createProject = await timed(page, async () => {
      await page.getByRole("button", { name: "New project" }).click();
      await expect(page.locator(".bot-row-active .bot-row-role")).toHaveText("CEO");
    });
    const header = page.locator(".bot-group-header").filter({ hasText: /launch-/ });
    await expect(header).toBeVisible();
    await header.hover();
    await header.getByRole("button", { name: /New chat in launch-/ }).click();
    await expect(page.locator(".bot-row-role").filter({ hasText: "CEO" })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("project.png") });

    timings.openOrganization = await timed(page, async () => {
      await page.getByRole("button", { name: "Organization" }).click();
      const panel = page.getByRole("complementary", { name: "Organization" });
      await expect(panel.getByRole("button", { name: /CEO/ })).toBeVisible();
    });
    await page.screenshot({ path: test.info().outputPath("organization.png") });
  } finally {
    console.log(`feel timings (ms): ${JSON.stringify(timings)}`);
    await test.info().attach("timings", { body: JSON.stringify(timings, null, 2) });
    await service.stop();
    await fixture.close();
  }
  expect(timings.switchChat).toBeLessThan(500);
  expect(timings.sendToBubble).toBeLessThan(500);
  expect(timings.answerCleared).toBeLessThan(1000);
});

async function timed(_page: Page, step: () => Promise<void>): Promise<number> {
  const started = Date.now();
  await step();
  return Date.now() - started;
}
