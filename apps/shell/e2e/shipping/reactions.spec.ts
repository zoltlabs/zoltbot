import { expect, test } from "@playwright/test";
import { messageReactionsKey, readMessageReactions } from "@zoltbot/protocol";
import type { RuntimeContext } from "../../../../packages/daemon/src/api";
import { chatSignalTools } from "../../../../packages/daemon/src/chat-signal-tools";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { axeViolations, shellSession } from "../harness";

test("owner reactions are saved by the daemon and agent reactions show with the agent", async ({
  page,
}) => {
  const fixture = await compareFixture();
  let shell = await shellSession(fixture.daemon);
  try {
    const bot = await shell.service.createBot({ profileId: "profile", title: "Release notes" });
    await shell.open(page);
    const sidebar = page.getByRole("complementary", { name: "Bot navigation" });
    await sidebar.getByRole("button", { name: /^Release notes/ }).click();
    const composer = page.getByRole("textbox", { name: "Message Release notes" });
    await composer.click();
    await composer.pressSequentially("Summarize the release");
    await composer.press("Enter");
    const answer = page.getByText("First answer").last();
    await expect(answer).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".bot-bubble-streaming")).toHaveCount(0, { timeout: 15_000 });

    // The owner's reaction goes to the daemon, where the phone reads it too.
    const entry = page.locator(".message-entry-bot").filter({ has: answer });
    await answer.hover();
    await entry.getByRole("button", { name: "Add reaction" }).click();
    await page
      .getByRole("dialog", { name: "Choose a reaction" })
      .getByRole("button", { name: "React with 🎉" })
      .click();
    await expect(entry.getByRole("button", { name: "Remove reaction 🎉" })).toBeVisible();
    const stored = () =>
      readMessageReactions(
        fixture.daemon.store.record("settings", messageReactionsKey(bot.id))?.value,
      );
    await expect.poll(() => stored().map((r) => `${r.actor}:${r.emoji}`)).toEqual(["owner:🎉"]);

    // The agent reacts to the person's message with the chat_signal tool.
    const signal = chatSignalTools({
      store: fixture.daemon.store,
      privacy: { prepareData: async () => () => undefined },
      publish() {},
    } as unknown as RuntimeContext);
    expect(
      await signal({
        actor: { agentId: "profile", threadId: bot.id, sessionId: "e2e" },
        arguments: { action: "react", emoji: "👀" },
        idempotencyKey: "agent-react",
      } as never),
    ).toEqual({ ok: true });
    await shell.close();
    shell = await shellSession(fixture.daemon);
    // A fresh window reads the stored reactions, as after a restart.
    const next = await page.context().newPage();
    await shell.open(next);
    await next
      .getByRole("complementary", { name: "Bot navigation" })
      .getByRole("button", { name: /^Release notes/ })
      .click();
    const mine = next.locator(".message-entry-user").filter({ hasText: "Summarize the release" });
    await expect(mine.getByRole("img", { name: "Release notes reacted 👀" })).toBeVisible({
      timeout: 15_000,
    });
    expect(await axeViolations(next)).toEqual([]);
    expect(shell.errors).toEqual([]);
  } finally {
    await shell.close();
    await fixture.close();
  }
});
