import { AxeBuilder } from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

const pageErrors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("http://127.0.0.1:5197/tests/results/");
});
test.afterEach(async ({ page }) => {
  expect(pageErrors.get(page)).toEqual([]);
});

test("results, exact-version comparison and feedback preserve the composer draft", async ({
  page,
}) => {
  await expect(page.getByRole("region", { name: "Completed work" })).toBeVisible();
  await page.getByRole("textbox", { name: /Message/ }).fill("Keep the existing navigation.");
  await page.getByRole("button", { name: "View results", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Results" });
  await expect(panel.getByRole("button", { name: /Field notes/ })).toBeVisible();
  await panel.getByRole("button", { name: "View 1 changed file" }).click();
  await expect(page.getByRole("dialog", { name: "Latest turn changes" })).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
  await panel.getByRole("button", { name: "Compare", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Compare artifacts" });
  await expect(dialog.locator("iframe")).toHaveCount(2);
  await expect(page.locator(".artifact-inline iframe")).toHaveCount(0);
  await expect(dialog.locator("iframe").first()).toHaveAttribute("sandbox", "allow-scripts");
  await dialog.getByLabel("Baseline version").selectOption("v1");
  await dialog.getByLabel("Alternative version").selectOption("v2");
  await expect(
    dialog.frameLocator('iframe[title="Field notes, version 1"]').getByRole("heading"),
  ).toHaveText("A quieter workspace");
  await expect(
    dialog.frameLocator('iframe[title="Field notes, version 2"]').getByRole("heading"),
  ).toHaveText("Space for your next idea");
  await dialog
    .getByRole("region", { name: "Alternative" })
    .getByLabel("Field notes zoom")
    .selectOption("150");
  await dialog
    .getByRole("region", { name: "Alternative" })
    .getByLabel("Field notes screen")
    .selectOption("home");
  await dialog.getByLabel("Feedback").fill("Keep the green button.");
  await dialog.getByRole("button", { name: "Use alternative" }).click();
  await expect(dialog).not.toBeVisible();
  const composer = page.getByRole("textbox", { name: /Message/ });
  await expect(composer).toHaveValue(
    /Keep the existing navigation\.[\s\S]*v2 \(v2\): Keep the green button\./,
  );
  await expect(page.getByText("Revise Field notes · v2", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(() =>
      (
        window as unknown as { resultsFixture: { calls: { method: string }[] } }
      ).resultsFixture.calls.filter((call) => call.method === "turn.send"),
    ),
  ).toEqual([]);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const sent = await page.evaluate(() =>
    (
      window as unknown as { resultsFixture: { calls: { method: string; params: unknown }[] } }
    ).resultsFixture.calls.filter((call) => call.method === "turn.send"),
  );
  expect(sent).toHaveLength(1);
  expect(sent[0]?.params).toMatchObject({
    threadId: "thread",
    artifactTarget: { artifactId: "artifact", versionId: "v2" },
  });
});

test("completion is suppressed for waits and uncertain delivery, then archives through the existing command", async ({
  page,
}) => {
  const card = page.getByRole("region", { name: "Completed work" });
  for (const [state, label] of [
    ["limited", "Usage limit reached"],
    ["reconnecting", "Coding tool reconnecting"],
    ["offline", "Waiting for connection"],
    ["background", "Background work in progress"],
    ["pending", "Needs you"],
    ["uncertain", "Message delivery needs review"],
    ["failed", ""],
  ]) {
    await page.getByLabel("Fixture state").selectOption(state ?? "online");
    await expect(card).not.toBeVisible();
    if (label) await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
  }
  await page.getByLabel("Fixture state").selectOption("online");
  await card.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(card).not.toBeVisible();
});

test("results and comparison remain accessible in both themes and narrow layouts", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Results", exact: true }).click();
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    const panel = page.getByRole("complementary", { name: "Results" });
    await page.screenshot({ animations: "disabled", path: `output/results-panel-${theme}.png` });
    await panel.getByRole("button", { name: "Compare", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Compare artifacts" });
    await expect(dialog.locator("iframe")).toHaveCount(2);
    const audit = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    expect(audit.violations).toEqual([]);
    await page.screenshot({
      animations: "disabled",
      path: `output/results-comparison-${theme}.png`,
    });
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
  }
  await page.setViewportSize({ width: 320, height: 844 });
  await page
    .getByRole("complementary", { name: "Results" })
    .getByRole("button", { name: "Compare", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Compare artifacts" });
  await expect(dialog.getByLabel("Alternative version")).toBeVisible();
  expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  await page.screenshot({ animations: "disabled", path: "output/results-comparison-narrow.png" });
  await dialog.getByLabel("Feedback").scrollIntoViewIfNeeded();
  await expect(dialog.getByLabel("Feedback")).toBeVisible();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("button", { name: "Results", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("letters share completion actions and Results preserves the preview preference", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Letters", exact: true }).click();
  await expect(page.getByRole("region", { name: "Completed work" })).toBeVisible();
  await page.getByRole("button", { name: "View results", exact: true }).click();
  const results = page.getByRole("complementary", { name: "Results" });
  await results.getByLabel("Previews in chat").uncheck();
  expect(await page.evaluate(() => localStorage.getItem("zoltbot.inline-artifacts"))).toBe(
    "disabled",
  );
  await results.getByRole("button", { name: "Field notes design" }).click();
  await expect(results.getByRole("region", { name: "Field notes viewer" })).toBeVisible();
  await expect(results.locator("iframe")).toHaveCount(1);
  await results.getByRole("button", { name: "Close artifact" }).click();
  await expect(results.getByLabel("Previews in chat")).not.toBeChecked();
});

test("an initial handoff appends once under Strict Mode", async ({ page }) => {
  await page.evaluate(() =>
    localStorage.setItem(
      "zoltbot.composerDraft.v1:thread",
      JSON.stringify({ text: "Keep this draft.", attachments: [], outputMode: "auto" }),
    ),
  );
  await page.goto("http://127.0.0.1:5197/tests/results/?handoff=1");
  await expect(page.getByRole("textbox", { name: /Message/ })).toHaveValue(
    "Keep this draft.\n\nReview this handoff.",
  );
});

test("comparison supports keyboard activation, focus restoration and 200% text", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Results", exact: true }).focus();
  await page.keyboard.press("Enter");
  const panel = page.getByRole("complementary", { name: "Results" });
  const compare = panel.getByRole("button", { name: "Compare", exact: true });
  await compare.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Compare artifacts" });
  await expect(dialog.getByLabel("Baseline version")).toBeFocused();
  await page.keyboard.press("Tab");
  const hasIndicator = await page.locator(":focus").evaluate((node) => {
    const style = getComputedStyle(node);
    return style.outlineStyle !== "none" || style.boxShadow !== "none";
  });
  expect(hasIndicator).toBe(true);
  await page.keyboard.press("Escape");
  await expect(compare).toBeFocused();
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  await expect(page.getByRole("button", { name: "Results", exact: true })).toBeInViewport();
  await compare.press("Enter");
  await expect(dialog.getByLabel("Alternative version")).toBeInViewport();
  await dialog.getByLabel("Feedback").scrollIntoViewIfNeeded();
  await expect(dialog.getByLabel("Feedback")).toBeInViewport();
  expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  await page.screenshot({
    animations: "disabled",
    path: "output/results-comparison-text-resize.png",
  });
});
