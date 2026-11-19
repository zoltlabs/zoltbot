import { expect, test } from "@playwright/test";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { axeViolations, shellSession } from "../harness";

/**
 * Ported from tests/compare/compare.spec.ts. The shell has no compare mode yet, so only the
 * single-session parts of that suite carry over: a native question is answered from the chat,
 * and stopping reaches the native session. Everything else is listed in NOT-PORTED.md.
 */
async function openFirst(page: import("@playwright/test").Page) {
  const fixture = await compareFixture();
  const shell = await shellSession(fixture.daemon);
  const bot = await shell.service.createBot({ profileId: "profile", title: "First" });
  await shell.open(page);
  const composer = page.getByRole("textbox", { name: "Message First" });
  await expect(composer).toBeVisible();
  return {
    fixture,
    shell,
    bot,
    composer,
    async close() {
      await shell.close();
      await fixture.close();
    },
  };
}

test("a native question appears in the chat and can be answered", async ({ page }) => {
  const f = await openFirst(page);
  try {
    await f.composer.click();
    await f.composer.pressSequentially("Ask a question");
    await f.composer.press("Enter");
    await expect(page.getByText("Choose an approach").last()).toBeVisible({ timeout: 15_000 });
    expect(await axeViolations(page)).toEqual([]);
    await page
      .getByRole("button", { name: /Use this approach/ })
      .first()
      .click();
    await page.getByRole("button", { name: "Send answer" }).click();
    await expect(page.getByText("Choose an approach")).toHaveCount(0, { timeout: 15_000 });
    await expect
      .poll(() => [...f.fixture.natives.values()].some((native) => native.replies.length > 0))
      .toBe(true);
    expect(f.shell.errors).toEqual([]);
  } finally {
    await f.close();
  }
});

test("stop reaches the running native session", async ({ page }) => {
  const f = await openFirst(page);
  try {
    await f.composer.click();
    await f.composer.pressSequentially("Take time to plan");
    await f.composer.press("Enter");
    await expect.poll(() => f.fixture.natives.size).toBe(1);
    await page.getByRole("button", { name: "Stop agent" }).click();
    await expect
      .poll(
        () =>
          f.fixture.daemon.store.snapshot().turn?.filter((row) => row.status === "running")
            .length ?? 0,
      )
      .toBe(0);
    expect([...f.fixture.natives.values()].map((native) => native.interrupted)).toEqual([1]);
    await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
    expect(f.shell.errors).toEqual([]);
  } finally {
    await f.close();
  }
});
