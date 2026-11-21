import { expect, test } from "@playwright/test";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { axeViolations, shellSession } from "../harness";

/** Set to a folder to save screenshots for review. */
const SHOTS = process.env.ZOLTBOT_SHOTS;

test("a downloaded update shows a pill that restarts into it, with its notes", async ({ page }) => {
  const fixture = await compareFixture();
  const shell = await shellSession(fixture.daemon);
  try {
    // A signed build's feed, stood in for: the test moves it through downloading and ready.
    await page.addInitScript(() => {
      const listeners = new Set<(status: unknown) => void>();
      const base = {
        currentVersion: "1.2.0",
        availableVersion: "1.3.0",
        checkedAt: "2026-11-21T06:00:00.000Z",
        message: null,
        releaseNotes: "• Faster search\n• Calmer sounds",
      };
      let status: Record<string, unknown> = { ...base, phase: "downloading", progress: 42 };
      const state = window as unknown as {
        installs: number;
        setUpdate: (patch: Record<string, unknown>) => void;
      };
      state.installs = 0;
      state.setUpdate = (patch) => {
        status = { ...status, ...patch };
        for (const listener of listeners) listener(status);
      };
      const update = {
        getStatus: async () => status,
        check: async () => status,
        download: async () => status,
        install: async () => {
          state.installs++;
        },
        onEvent: (listener: (status: unknown) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
      let api: { update?: unknown } | undefined;
      Object.defineProperty(window, "openbot", {
        configurable: true,
        get: () => api,
        set: (value) => {
          api = value;
          if (api) api.update = update;
        },
      });
    });
    await shell.open(page);

    await expect(page.getByText("Downloading 42%")).toBeVisible();
    await page.evaluate(() =>
      (window as unknown as { setUpdate: (patch: Record<string, unknown>) => void }).setUpdate({
        phase: "ready",
        progress: 100,
      }),
    );
    const restart = page.getByRole("button", { name: "Restart to update" });
    await expect(restart).toBeVisible();
    await page.getByRole("button", { name: "What’s new" }).click();
    const notes = page.getByRole("dialog", { name: "What’s new" });
    await expect(notes).toContainText("Faster search");
    expect(await axeViolations(page)).toEqual([]);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/d3-pill.png` });
    await page.keyboard.press("Escape");
    await expect(notes).toHaveCount(0);

    await restart.click();
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { installs: number }).installs))
      .toBe(1);
    expect(shell.errors).toEqual([]);
  } finally {
    await shell.close();
    await fixture.close();
  }
});
