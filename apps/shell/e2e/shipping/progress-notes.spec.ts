import { expect, test } from "@playwright/test";
import type { RuntimeContext } from "../../../../packages/daemon/src/api";
import { chatSignalTools } from "../../../../packages/daemon/src/chat-signal-tools";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { axeViolations, shellSession } from "../harness";

test("progress notes show as small bubbles between the question and the answer", async ({
  page,
}) => {
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
    // The fake takes 3 seconds to answer "Take time", long enough to post a note.
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
        arguments: { progress: "Read the notes; checking the changelog next." },
        idempotencyKey: "agent-progress",
      } as never),
    ).toEqual({ ok: true });
    const note = page.locator(".progress-note");
    await expect(note).toHaveText(/Read the notes; checking the changelog next\./);
    await expect(note.locator(".sr-only")).toHaveText("Progress note:");

    // The note stays after the turn ends, between the question and the answer.
    await expect(page.locator(".bot-bubble-streaming")).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByRole("button", { name: "Stop agent" })).toHaveCount(0, {
      timeout: 15_000,
    });
    const order = await page
      .locator(".message-entry-user, .progress-note, .message-entry-bot")
      .evaluateAll((nodes) =>
        nodes.map((node) =>
          node.classList.contains("progress-note")
            ? "note"
            : node.classList.contains("message-entry-user")
              ? "user"
              : "agent",
        ),
      );
    expect(order.slice(-3)).toEqual(["user", "note", "agent"]);
    expect(await axeViolations(page)).toEqual([]);
    expect(shell.errors).toEqual([]);
  } finally {
    await shell.close();
    await fixture.close();
  }
});
