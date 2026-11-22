import { expect, test } from "@playwright/test";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { axeViolations, COLOR_SCHEMES, settleColorScheme, shellSession } from "../harness";

test("the model picker searches, stars and lists starred models first", async ({ page: first }) => {
  const fixture = await compareFixture({
    models: [
      { id: "opus", name: "Opus" },
      { id: "sonnet", name: "Sonnet" },
      { id: "haiku", name: "Haiku" },
    ],
  });
  const shell = await shellSession(fixture.daemon);
  try {
    await shell.service.createBot({ profileId: "profile", title: "Reviews" });
    await shell.open(first);
    const reviews = (page: typeof first) =>
      page
        .getByRole("complementary", { name: "Bot navigation" })
        .getByRole("button", { name: /^Reviews/ })
        .click();
    await reviews(first);
    const composer = first.getByRole("textbox", { name: "Message Reviews" });
    await composer.click();
    await composer.pressSequentially("Hello");
    await composer.press("Enter");
    await expect(first.getByText("First answer")).toBeVisible({ timeout: 15_000 });
    // The fixture's tool counts as installed, so its models can be chosen.
    (shell.service as unknown as { agentChecks: Map<string, unknown> }).agentChecks = new Map([
      ["fake", { install: { selected: { path: "/bin/fake", version: "1.0.0" } } }],
    ]);
    // The catalog now knows the models; a new window loads them.
    const page = await first.context().newPage();
    await shell.open(page);
    await reviews(page);

    await page.getByRole("button", { name: /^Agent model/ }).click();
    const panel = page.getByRole("dialog", { name: "Choose agent model" });
    const search = panel.getByRole("combobox", { name: "Search models" });
    await expect(search).toBeFocused();

    // Search ranks the best match first.
    await search.fill("snt");
    // The fixture's two tools share an adapter, so each model is listed once per tool.
    // Each result keeps its provider as its detail.
    await expect(panel.getByRole("option").first()).toHaveAccessibleName("Sonnet, Fake");
    await expect(panel.getByRole("option").filter({ hasNotText: "Sonnet" })).toHaveCount(0);
    await search.fill("");

    // Keyboard: move to Haiku, Tab to the star button, star it.
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Tab");
    const star = panel.getByRole("button", { name: /^Star / });
    await expect(star).toBeFocused();
    await expect(star).toHaveAccessibleName(/^Star /);
    const name = (await star.getAttribute("aria-label"))?.replace(/^Star /, "") ?? "";
    await page.keyboard.press("Enter");
    await expect(panel.getByRole("button", { name: `Unstar ${name}` })).toBeVisible();
    // Starred models list first, and their names say so.
    await expect(panel.getByRole("option").first()).toHaveAccessibleName(
      new RegExp(`^${name}.*Starred$`),
    );
    await expect.poll(() => shell.service.accounts.starred()).toEqual([expect.any(String)]);

    for (const scheme of COLOR_SCHEMES) {
      await page.emulateMedia({ colorScheme: scheme });
      await settleColorScheme(page, scheme);
      expect(await axeViolations(page)).toEqual([]);
      if (process.env.ZB_SHOTS)
        await page.screenshot({ path: `${process.env.ZB_SHOTS}/a8-starred-${scheme}.png` });
    }

    // Unstar it again.
    await panel.getByRole("button", { name: `Unstar ${name}` }).click();
    await expect(panel.getByRole("option", { name: /Starred$/ })).toHaveCount(0);
    await expect.poll(() => shell.service.accounts.starred()).toEqual([]);
    await page.keyboard.press("Escape");
    expect(shell.errors).toEqual([]);
  } finally {
    await shell.close();
    await fixture.close();
  }
});
