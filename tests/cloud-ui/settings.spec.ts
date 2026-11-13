import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type {} from "./main.js";

test("validates and saves through a session-bound port, clears the input and preserves focus while pending", async ({
  page,
}) => {
  await page.goto("/tests/cloud-ui/?slowSave");
  const form = page.getByRole("form", { name: "Save Anthropic API key" }),
    input = form.getByLabel("Anthropic API key", { exact: true }),
    save = form.getByRole("button", { name: "Save Anthropic API key" });
  await save.click();
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute("aria-invalid", "true");
  await expect(form.getByText("Enter a key.")).toBeVisible();
  await input.fill("  example-value  ");
  await save.focus();
  await page.keyboard.press("Enter");
  await expect(save).toBeFocused();
  await expect(save).toHaveAttribute("aria-disabled", "true");
  await expect(form.getByRole("status")).toHaveText("Saving…");
  await page.keyboard.press("Enter");
  expect(
    await page.evaluate(
      () => window.cloudFixture.calls.filter((call) => call.method === "secret").length,
    ),
  ).toBe(1);
  await page.evaluate(() => window.cloudFixture.finishSave());
  await expect(input).toHaveValue("");
  await expect(form.getByRole("status")).toHaveText("Key saved.");
  expect(await page.evaluate(() => window.cloudFixture.calls[0])).toEqual({
    method: "secret",
    name: "anthropic",
    sessionId: "session-one",
    length: 13,
  });
  await page.getByRole("checkbox", { name: "Run cloud tasks on this Mac" }).check();
  await expect(page.getByRole("checkbox", { name: "Run cloud tasks on this Mac" })).toBeChecked();
  await page
    .getByRole("combobox", { name: "Run on my Mac", exact: true })
    .selectOption("allow_listed");
  expect(
    await page.evaluate(() => window.cloudFixture.calls.find((call) => call.method === "mode")),
  ).toEqual({ method: "mode", sessionId: "session-one", mode: "allow_listed" });
});

test("clears an old account's draft and ignores its completed save after an account change", async ({
  page,
}) => {
  await page.goto("/tests/cloud-ui/?slowSave");
  const form = page.getByRole("form", { name: "Save OpenAI API key" });
  await form.getByLabel("OpenAI API key", { exact: true }).fill("example-value");
  await form.getByRole("button", { name: "Save OpenAI API key" }).click();
  await page.evaluate(() => window.cloudFixture.switchAccount());
  await expect(page.getByText("Another organization", { exact: true })).toBeVisible();
  const next = page.getByRole("form", { name: "Save OpenAI API key" });
  await expect(next.getByLabel("OpenAI API key", { exact: true })).toHaveValue("");
  await page.evaluate(() => window.cloudFixture.finishSave());
  await expect(next.getByRole("status")).toBeEmpty();
  await next.getByLabel("OpenAI API key", { exact: true }).fill("replacement");
  await next.getByRole("button", { name: "Save OpenAI API key" }).click();
  expect(
    await page.evaluate(() =>
      window.cloudFixture.calls
        .filter((call) => call.method === "secret")
        .map((call) => call.sessionId),
    ),
  ).toEqual(["session-one", "session-two"]);
});

test("shows a key-save error without discarding the draft and recovers from a load error", async ({
  page,
}) => {
  await page.goto("/tests/cloud-ui/?error");
  await expect(page.getByRole("alert")).toContainText("Could not load");
  await page.evaluate(() => window.cloudFixture.failStatus(false));
  await page.getByRole("button", { name: "Reload settings" }).click();
  const form = page.getByRole("form", { name: "Save GitHub token" });
  await form.getByLabel("GitHub token", { exact: true }).fill("example-value");
  await page.evaluate(() => window.cloudFixture.failSave(true));
  await form.getByRole("button", { name: "Save GitHub token" }).click();
  await expect(form.getByRole("alert")).toContainText("Check your connection");
  await expect(form.getByLabel("GitHub token", { exact: true })).toHaveValue("example-value");
  await page.evaluate(() => window.cloudFixture.failSave(false));
  await form.getByRole("button", { name: "Save GitHub token" }).click();
  await expect(form.getByLabel("GitHub token", { exact: true })).toHaveValue("");
});

for (const state of ["signedOut", "notEligible", "offline", "unconfigured", "disabled"]) {
  test(`renders the ${state} state`, async ({ page }) => {
    await page.goto(`/tests/cloud-ui/?${state}`);
    if (state === "signedOut") {
      await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
      await expect(page.getByRole("checkbox")).toHaveCount(0);
    }
    if (state === "notEligible") {
      await expect(page.getByRole("button", { name: "Open account settings" })).toBeVisible();
      await expect(page.getByRole("checkbox", { name: "Enable Zoltbot Cloud" })).toBeDisabled();
    }
    if (state === "offline") {
      await expect(page.getByText("Cloud is offline. Reconnect to change settings.")).toBeVisible();
      await expect(page.getByLabel("Anthropic API key", { exact: true })).toBeDisabled();
    }
    if (state === "unconfigured") {
      await expect(page.getByText("Cloud is not available in this version.")).toBeVisible();
      await expect(page.getByRole("checkbox")).toHaveCount(0);
    }
    if (state === "disabled") {
      await expect(page.getByRole("checkbox", { name: "Enable Zoltbot Cloud" })).not.toBeChecked();
      await expect(page.getByRole("form")).toHaveCount(0);
    }
  });
}

for (const theme of ["dark", "light"]) {
  test(`has accessible controls and reflows in ${theme}`, async ({ page }) => {
    await page.goto(`/tests/cloud-ui/?theme=${theme}`);
    await expect(page.getByLabel("Anthropic API key", { exact: true })).toBeVisible();
    expect((await new AxeBuilder({ page }).include("main").analyze()).violations).toEqual([]);
    const contrast = await page.evaluate(() => {
      const luminance = (rgb: string) => {
        const channels = rgb
          .match(/[\d.]+/g)
          ?.slice(0, 3)
          .map(Number);
        if (!channels || channels.length !== 3) throw new Error("fixture_color_missing");
        return channels.reduce((sum, channel, index) => {
          const value = channel / 255;
          return (
            sum +
            (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4) *
              ([0.2126, 0.7152, 0.0722][index] ?? 0)
          );
        }, 0);
      };
      const ratio = (foreground: string, background: string) => {
        const a = luminance(foreground),
          b = luminance(background);
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      };
      const card = document.querySelector(".cloud-settings"),
        label = document.querySelector(".zb-field-label"),
        hint = document.querySelector(".settings-hint"),
        input = document.querySelector("input[type=password]");
      if (!card || !label || !hint || !input) throw new Error("fixture_control_missing");
      const surface = getComputedStyle(card).backgroundColor,
        control = getComputedStyle(input);
      // Sunken surfaces may be translucent; measure the composited paint.
      const foreground = control.backgroundColor.match(/[\d.]+/g)?.map(Number),
        underneath = surface.match(/[\d.]+/g)?.map(Number);
      if (!foreground || !underneath) throw new Error("fixture_color_missing");
      const alpha = foreground[3] ?? 1;
      const fieldBackground = `rgb(${foreground
        .slice(0, 3)
        .map((channel, index) => channel * alpha + (underneath[index] ?? 0) * (1 - alpha))
        .join(",")})`;
      return {
        label: ratio(getComputedStyle(label).color, surface),
        hint: ratio(getComputedStyle(hint).color, surface),
        fieldText: ratio(control.color, fieldBackground),
        fieldBoundary: ratio(control.borderColor, fieldBackground),
        fieldBoundaryOutside: ratio(control.borderColor, surface),
      };
    });
    expect(contrast.label).toBeGreaterThanOrEqual(4.5);
    expect(contrast.hint).toBeGreaterThanOrEqual(4.5);
    expect(contrast.fieldText).toBeGreaterThanOrEqual(4.5);
    expect(contrast.fieldBoundary).toBeGreaterThanOrEqual(3);
    expect(contrast.fieldBoundaryOutside).toBeGreaterThanOrEqual(3);
    console.log(theme, "Cloud settings contrast", contrast);
    await page.screenshot({
      path: `output/playwright/cloud-settings-${theme}.png`,
      fullPage: true,
    });
    await page.setViewportSize({ width: 320, height: 900 });
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
    });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
    await page.getByLabel("Anthropic API key", { exact: true }).focus();
    await expect(page.getByLabel("Anthropic API key", { exact: true })).toBeFocused();
    expect(
      await page
        .getByLabel("Anthropic API key", { exact: true })
        .evaluate((element) => getComputedStyle(element).boxShadow !== "none"),
    ).toBe(true);
    await page.screenshot({
      path: `output/playwright/cloud-settings-${theme}-narrow.png`,
      fullPage: true,
    });
  });
}
