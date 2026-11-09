import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { launch, testUiUrl } from "./desktop.js";

for (const theme of ["light", "dark"] as const)
  test(`visual language in ${theme} theme`, async () => {
    // Keep machine-specific native update notices outside deterministic component baselines.
    const fixture = await launch(true);
    const { page } = fixture;
    try {
      await fixture.app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.setSize(1320, 1200),
      );
      await page.setViewportSize({ width: 1320, height: 1200 });
      await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
      await page.goto(`${testUiUrl}/#components`);
      await expect(
        page.getByRole("heading", { name: "Visual language", exact: true }),
      ).toBeVisible();
      if ((await page.locator("html").getAttribute("data-theme")) !== theme)
        await page.getByRole("button", { name: `Use ${theme} theme`, exact: true }).click();
      const gallery = page.locator(".component-gallery");
      await expect(gallery).toHaveCSS("display", "flex");
      await expect(gallery.locator(".gallery-section").first()).toHaveCSS("padding", "20px");
      await expect(
        gallery.getByRole("button", { name: "Unavailable", exact: true }),
      ).toBeDisabled();
      await gallery.getByRole("button", { name: "Primary action" }).click();
      await expect(gallery.getByText("Actions: 1", { exact: true })).toBeVisible();
      await gallery.getByRole("tab", { name: "Context", exact: true }).focus();
      await page.keyboard.press("ArrowRight");
      await expect(gallery.getByRole("tab", { name: "Run", exact: true })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await page.keyboard.press("Tab");
      await expect(gallery.getByRole("tabpanel", { name: "Run", exact: true })).toBeFocused();
      await gallery.getByRole("tab", { name: "Context", exact: true }).click();
      await expect(gallery.getByRole("progressbar", { name: "Context window" })).toHaveAttribute(
        "aria-valuenow",
        "38",
      );
      const scan = await new AxeBuilder({ page }).setLegacyMode().analyze();
      expect(scan.violations).toEqual([]);
      await gallery.locator("article.zb-stage").last().scrollIntoViewIfNeeded();
      await expect(gallery.locator("article.zb-stage").last()).toBeInViewport({ ratio: 1 });
      // The gallery is taller than the window; let the document scroll so the capture is whole.
      // The native textarea resize grip renders a few pixels differently between launches.
      await page.addStyleTag({
        content:
          ".workspace-shell, .main-content { height: auto; overflow: visible; } textarea { resize: none; }",
      });
      // macOS image versions rasterize native text/controls differently on CI and local Macs.
      await expect(gallery).toHaveScreenshot(
        `components-${theme}${process.env.CI ? "-ci" : ""}.png`,
        {
          animations: "disabled",
          scale: "css",
        },
      );
    } finally {
      await fixture.cleanup();
    }
  });
