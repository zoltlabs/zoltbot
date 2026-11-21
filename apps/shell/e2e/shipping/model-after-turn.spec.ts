import { expect, test } from "@playwright/test";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { axeViolations, COLOR_SCHEMES, settleColorScheme, shellSession } from "../harness";

test("a model chosen during a turn switches when the turn ends, and can be undone", async ({
  page: first,
}) => {
  const fixture = await compareFixture({
    models: [
      { id: "sonnet", name: "Sonnet" },
      { id: "opus", name: "Opus" },
    ],
  });
  const shell = await shellSession(fixture.daemon);
  try {
    const bot = await shell.service.createBot({ profileId: "profile", title: "Reviews" });
    // The agent starts on Sonnet, so Undo has a model to return to.
    await shell.service.updateBot({ botId: bot.id, model: "sonnet" });
    await shell.open(first);
    const reviews = (page: typeof first) =>
      page
        .getByRole("complementary", { name: "Bot navigation" })
        .getByRole("button", { name: /^Reviews/ })
        .click();
    await reviews(first);
    const send = async (page: typeof first, message: string) => {
      const composer = page.getByRole("textbox", { name: "Message Reviews" });
      await composer.click();
      await composer.pressSequentially(message);
      await composer.press("Enter");
    };
    await send(first, "Hello");
    await expect(first.getByText("First answer")).toBeVisible({ timeout: 15_000 });
    // The fixture's tool counts as installed, so its models can be chosen.
    (shell.service as unknown as { agentChecks: Map<string, unknown> }).agentChecks = new Map([
      ["fake", { install: { selected: { path: "/bin/fake", version: "1.0.0" } } }],
    ]);
    // The catalog now knows the models; a new window loads them.
    const page = await first.context().newPage();
    await shell.open(page);
    await reviews(page);
    const native = () => fixture.natives.get(bot.threadId ?? "");
    const answers = page.getByRole("main", { name: "Conversation" }).getByText("First answer");
    const thinking = page
      .getByRole("complementary", { name: "Bot navigation" })
      .getByRole("button", { name: /^Reviews.*Thinking/ });
    const trigger = page.getByRole("button", { name: /^Agent model/ });
    const choose = async (name: string) => {
      await trigger.click();
      const panel = page.getByRole("dialog", { name: "Choose agent model" });
      await panel
        .getByRole("option", { name: new RegExp(`^${name}`) })
        .first()
        .click();
    };
    const held = page.getByText("Switches to Opus after this reply");

    // A slow reply is running; the picker stays open for changes.
    await send(page, "Take time over this");
    await expect(thinking).toBeVisible();
    await expect(trigger).toBeEnabled();
    await choose("Opus");
    await expect(held).toBeVisible();
    // Undo drops the held change while the reply is still running.
    await page.getByRole("button", { name: "Undo switch to Opus" }).click();
    await expect(held).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(thinking).toBeVisible();
    // The reply ends with no model change reaching the provider.
    await expect(answers).toHaveCount(2, { timeout: 20_000 });
    await expect(thinking).toBeHidden({ timeout: 20_000 });
    await page.waitForTimeout(500);
    expect(native()?.modelCalls).toEqual([]);

    // Chosen during the next slow reply, it reaches the provider once that reply ends.
    await send(page, "Take time again");
    await expect(thinking).toBeVisible();
    await choose("Opus");
    await expect(held).toBeVisible();
    expect(native()?.modelCalls).toEqual([]);
    for (const scheme of COLOR_SCHEMES) {
      await page.emulateMedia({ colorScheme: scheme });
      await settleColorScheme(page, scheme);
      expect(await axeViolations(page)).toEqual([]);
      if (process.env.ZB_SHOTS)
        await page.screenshot({ path: `${process.env.ZB_SHOTS}/a10-held-${scheme}.png` });
    }
    await expect(held).toBeHidden({ timeout: 20_000 });
    await expect.poll(() => native()?.modelCalls.map(([model]) => model)).toEqual(["opus"]);
    await expect(trigger).toHaveAccessibleName(/Opus/);
    expect(shell.errors).toEqual([]);
  } finally {
    await shell.close();
    await fixture.close();
  }
});
