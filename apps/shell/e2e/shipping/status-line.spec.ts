import { expect, test } from "@playwright/test";
import type { RuntimeContext } from "../../../../packages/daemon/src/api";
import { chatSignalTools } from "../../../../packages/daemon/src/chat-signal-tools";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { axeViolations, shellSession } from "../harness";

test("the working line shows what the agent says it is doing", async ({ page }) => {
  const fixture = await compareFixture();
  const shell = await shellSession(fixture.daemon);
  try {
    const bot = await shell.service.createBot({ profileId: "profile", title: "Release notes" });
    await shell.open(page);
    await page
      .getByRole("complementary", { name: "Bot navigation" })
      .getByRole("button", { name: /^Release notes/ })
      .click();
    const composer = page.getByRole("textbox", { name: "Message Release notes" });
    await composer.click();
    // The fake takes 3 seconds to answer "Take time", long enough to set a status.
    await composer.pressSequentially("Take time to read the notes");
    await composer.press("Enter");
    await expect(page.getByRole("button", { name: "Stop agent" })).toBeVisible({ timeout: 15_000 });
    const turn = () =>
      (fixture.daemon.store.snapshot(["turn"]).turn ?? []).find(
        (row) => row.threadId === bot.id && row.status === "running",
      );
    await expect.poll(() => turn()?.id).toBeTruthy();

    // The daemon broadcasts the stored row; here the test hands it to the Mac's client itself.
    const client = shell.service.client as unknown as { apply(event: unknown): void };
    const signal = chatSignalTools({
      store: fixture.daemon.store,
      privacy: { prepareData: async () => () => undefined, containsSecret: async () => false },
      publish: (events: unknown[]) => {
        for (const event of events) client.apply(event);
      },
    } as unknown as RuntimeContext);
    expect(
      await signal({
        actor: {
          agentId: "profile",
          threadId: bot.id,
          sessionId: "e2e",
          turnId: String(turn()?.id),
        },
        arguments: { status: "Reading the release notes" },
        idempotencyKey: "agent-status",
      } as never),
    ).toEqual({ ok: true });
    const working = page.getByRole("status", { name: "Release notes is working" });
    await expect(working).toHaveAccessibleDescription("Reading the release notes");
    await expect(page.locator(".agent-activity-line")).toHaveText("Reading the release notes");
    expect(await axeViolations(page)).toEqual([]);

    // When the turn ends, the line goes with it.
    await expect(page.getByText("Reading the release notes")).toHaveCount(0, { timeout: 15_000 });
    expect(shell.errors).toEqual([]);
  } finally {
    await shell.close();
    await fixture.close();
  }
});
