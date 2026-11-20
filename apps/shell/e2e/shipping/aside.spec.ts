import { expect, type Page, test } from "@playwright/test";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { axeViolations, COLOR_SCHEMES, settleColorScheme, shellSession } from "../harness";

async function type(page: Page, text: string) {
  const composer = page.getByRole("textbox", { name: "Message Release notes" });
  await composer.click();
  await composer.pressSequentially(text);
}

const said = (input: unknown) =>
  (input as { type: string; text?: string }[]).map((part) => part.text ?? "").join("");

test("a side question is answered without touching the running turn", async ({ page }) => {
  const fixture = await compareFixture();
  const shell = await shellSession(fixture.daemon);
  try {
    await shell.service.createBot({ profileId: "profile", title: "Release notes" });
    await shell.open(page);
    const sidebar = page.getByRole("complementary", { name: "Bot navigation" });
    await sidebar.getByRole("button", { name: /^Release notes/ }).click();

    // The fake takes 3 seconds to answer "Take time", long enough to ask aside.
    await type(page, "Take time to read the notes");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Stop agent" })).toBeVisible({ timeout: 15_000 });
    const toggle = page.getByRole("button", { name: "Ask aside" });
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await type(page, "Which file is it in?");
    await page.keyboard.press("Enter");

    const asked = page.getByRole("article", { name: "Side question", exact: true });
    await expect(asked).toContainText("Which file is it in?");
    const answer = page.getByRole("article", { name: "Answer to side question" });
    await expect(answer.getByRole("button", { name: "Continue in new chat" })).toBeVisible({
      timeout: 20_000,
    });
    for (const scheme of COLOR_SCHEMES) {
      await settleColorScheme(page, scheme);
      expect(await axeViolations(page)).toEqual([]);
    }

    // The chat's own agent saw only its message; the aside ran in its own session.
    const natives = [...fixture.natives.values()];
    expect(natives).toHaveLength(2);
    expect(natives[0]?.received.map(said)).toEqual(["Take time to read the notes"]);
    expect(said(natives[1]?.received[0])).toContain("Which file is it in?");
    await expect(sidebar.getByRole("button", { name: /^Which file is it in/ })).toHaveCount(0);

    await answer.getByRole("button", { name: "Continue in new chat" }).click();
    await expect(sidebar.getByRole("button", { name: /^Which file is it in/ })).toBeVisible();
    expect(shell.errors).toEqual([]);
  } finally {
    await shell.close();
    await fixture.close();
  }
});
