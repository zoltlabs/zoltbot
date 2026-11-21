import { expect, test } from "@playwright/test";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { axeViolations, shellSession } from "../harness";

/** Set to a folder to save screenshots for review. */
const SHOTS = process.env.ZOLTBOT_SHOTS;

test("Move to another computer previews an import and applies it", async ({ page }) => {
  const fixture = await compareFixture();
  const shell = await shellSession(fixture.daemon);
  try {
    // Main's file dialogs stand in: the test answers them and records what was applied.
    await page.addInitScript(() => {
      const applied: unknown[] = [];
      (window as unknown as { applied: unknown[] }).applied = applied;
      const bundle = {
        export: async () => ({ saved: true }),
        preview: async () => ({
          previewId: "bundle:1",
          agents: 1,
          items: [
            { id: "agent:writer", kind: "agent", name: "Writer", action: "add" },
            { id: "settings:style.tone", kind: "settings", name: "style.tone", action: "replace" },
          ],
          connections: ["GitHub"],
          tools: [],
        }),
        apply: async (input: unknown) => {
          applied.push(input);
        },
      };
      let api: { bundle?: unknown } | undefined;
      Object.defineProperty(window, "openbot", {
        configurable: true,
        get: () => api,
        set: (value) => {
          api = value;
          if (api) api.bundle = bundle;
        },
      });
    });
    await shell.open(page);

    await page.getByRole("button", { name: "Open account menu" }).click();
    await page
      .getByRole("menu")
      .getByRole("menuitem", { name: "Move to another computer" })
      .click();
    const move = page.getByRole("dialog", { name: "Move to another computer" });
    await expect(move).toContainText("Saved logins and connection sign-ins aren’t included.");
    expect(await axeViolations(page)).toEqual([]);
    await move.getByRole("button", { name: "Import…" }).click();

    const preview = page.getByRole("dialog", { name: "Import 1 agent" });
    await expect(preview).toContainText("Writer");
    await expect(preview).toContainText("Replaces");
    await expect(preview).toContainText("Sign in again here: GitHub");
    expect(await axeViolations(page)).toEqual([]);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/d7-import.png` });
    await preview.getByRole("button", { name: "Import", exact: true }).click();
    await expect(preview).toHaveCount(0);
    expect(
      await page.evaluate(() => (window as unknown as { applied: unknown[] }).applied),
    ).toEqual([{ previewId: "bundle:1", selected: ["agent:writer", "settings:style.tone"] }]);
    expect(shell.errors).toEqual([]);
  } finally {
    await shell.close();
    await fixture.close();
  }
});
