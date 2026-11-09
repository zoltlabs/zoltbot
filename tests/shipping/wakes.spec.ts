import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { chromium, expect, test } from "@playwright/test";
import { handle } from "../../packages/core/src/index.js";
import { startDaemon } from "../../packages/daemon/src/api.js";
import { runtimeFixture } from "../../tools/fakes/src/runtime-fixture.js";

test("Wake when: save, edit, cancel, fallback, and accessible responsive review", async () => {
  test.setTimeout(120000);
  const f = await runtimeFixture("zoltbot.db");
  const now = new Date().toISOString();
  f.store.dispatch("job", (s) =>
    handle(
      s,
      {
        type: "update",
        kind: "session",
        id: "session",
        changes: {
          background: [
            { id: "unit-tests", kind: "shell", description: "Run unit tests", state: "running" },
          ],
        },
      },
      { commandId: "job", at: now, actor: { kind: "system", id: "fixture" } },
    ),
  );
  const daemon = await startDaemon({
    dataDir: f.root,
    origins: ["http://127.0.0.1:5189"],
    eventRoutineTransport: async (endpoint) => {
      if (endpoint === "/user") return { id: 1 };
      if (endpoint === "/repos/example/app") return { id: 2, full_name: "example/app" };
      if (endpoint === "/repos/example/app/pulls/42")
        return { number: 42, merged: false, state: "open" };
      throw new Error("fixture_unexpected_endpoint");
    },
  });
  const browser = await chromium.launch({
    headless: true,
    executablePath: existsSync(chromium.executablePath())
      ? chromium.executablePath()
      : path.join(
          homedir(),
          "Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell",
        ),
  });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      colorScheme: "dark",
    });
    await context.addInitScript(
      ({ url, token }) => {
        localStorage.setItem("zoltbot.theme.v1", "system");
        window.zoltDesktop = {
          connection: async () => ({ url, token }),
          onConnectionChanged: () => () => {},
          visibleThread() {},
        };
      },
      { url: daemon.url, token: daemon.token },
    );
    const page = await context.newPage(),
      errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("http://127.0.0.1:5189/#chat/thread");
    const trigger = page.getByRole("button", { name: "Wake when…", exact: true });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "Wake when…", exact: true });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Exact job", { exact: true }).selectOption("session|unit-tests");
    await dialog.getByLabel("Then", { exact: true }).selectOption("resume");
    await dialog.getByLabel("Next step").fill("Read test results and explain failures.");
    expect((await new AxeBuilder({ page }).include("dialog").analyze()).violations).toEqual([]);
    // Every form control is keyboard reachable, with focus trapped and visibly indicated.
    for (let step = 0; step < 10; step++) {
      await page.keyboard.press("Tab");
      expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
      const focused = await page.evaluate(() => {
        const active = document.activeElement;
        if (!active) return { visible: false, tag: "none" };
        const style = getComputedStyle(active);
        return {
          tag: active.tagName,
          id: active.id,
          visible:
            active.matches("dialog") ||
            (style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0) ||
            style.boxShadow !== "none",
        };
      });
      expect(focused.visible, JSON.stringify(focused)).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(trigger).toBeFocused();
    await trigger.click();
    await dialog.getByLabel("Condition", { exact: true }).selectOption("pr");
    await dialog.getByLabel("GitHub repository").fill("example/app");
    await dialog.getByLabel("Pull request number").fill("42");
    await dialog.getByLabel("Then", { exact: true }).selectOption("resume");
    await dialog.getByLabel("Next step").fill("Inspect the merged changes.");
    await page.screenshot({ path: "output/playwright/wakes-editor-dark.png", fullPage: true });
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
      await expect(page.locator("html")).toHaveAttribute("data-theme", colorScheme);
      const boundaryContrast = await dialog.evaluate((d) => {
        const input = d.querySelector("input"),
          canvas = document.createElement("canvas"),
          ctx = canvas.getContext("2d");
        if (!input || !ctx) throw new Error("input contrast unavailable");
        const rgba = (value: string) => {
          ctx.clearRect(0, 0, 1, 1);
          ctx.fillStyle = value;
          ctx.fillRect(0, 0, 1, 1);
          return Array.from(ctx.getImageData(0, 0, 1, 1).data);
        };
        const over = (fg: number[], bg: number[]) =>
          fg
            .slice(0, 3)
            .map((v, i) => (v * (fg[3] ?? 255)) / 255 + (bg[i] ?? 0) * (1 - (fg[3] ?? 255) / 255));
        const luma = (rgb: number[]) =>
          rgb.slice(0, 3).reduce((n, v, i) => {
            const c = v / 255;
            return (
              n +
              (i === 0 ? 0.2126 : i === 1 ? 0.7152 : 0.0722) *
                (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
            );
          }, 0);
        const ratio = (a: number[], b: number[]) =>
          (Math.max(luma(a), luma(b)) + 0.05) / (Math.min(luma(a), luma(b)) + 0.05);
        const style = getComputedStyle(input),
          outside = rgba(getComputedStyle(d).backgroundColor),
          inside = over(rgba(style.backgroundColor), outside),
          border = over(rgba(style.borderTopColor), inside);
        return { inside: ratio(border, inside), outside: ratio(border, outside) };
      });
      expect(boundaryContrast.inside).toBeGreaterThanOrEqual(3);
      expect(boundaryContrast.outside).toBeGreaterThanOrEqual(3);
      await page.setViewportSize({ width: 320, height: 740 });
      expect((await new AxeBuilder({ page }).include("dialog").analyze()).violations).toEqual([]);
      expect(await dialog.evaluate((d) => d.scrollWidth <= d.clientWidth + 1)).toBe(true);
      await dialog.getByRole("button", { name: "Save wait", exact: true }).scrollIntoViewIfNeeded();
      await expect(dialog.getByRole("button", { name: "Save wait", exact: true })).toBeInViewport();
      await page.screenshot({
        path: `output/playwright/wakes-editor-${colorScheme}-320.png`,
        fullPage: true,
      });
    }
    await page.screenshot({ path: "output/playwright/wakes-editor-narrow.png", fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => {
      document.documentElement.style.zoom = "2";
      document.documentElement.dir = "rtl";
    });
    expect(await dialog.evaluate((d) => d.scrollWidth <= d.clientWidth + 1)).toBe(true);
    await dialog.getByRole("button", { name: "Save wait", exact: true }).scrollIntoViewIfNeeded();
    await expect(dialog.getByRole("button", { name: "Save wait", exact: true })).toBeInViewport();
    await dialog.getByRole("heading").scrollIntoViewIfNeeded();
    await expect(dialog.getByRole("heading")).toBeInViewport();
    await page.evaluate(() => {
      document.documentElement.style.zoom = "";
      document.documentElement.dir = "";
    });
    const fallback = dialog.getByLabel("Fallback time (your local timezone)");
    const future = await fallback.inputValue();
    await fallback.fill("2000-01-01T09:00");
    await dialog.getByRole("button", { name: "Save wait", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("Choose a fallback time in the future");
    await expect(fallback).toHaveAttribute("aria-invalid", "true");
    await expect(fallback).toBeFocused();
    await fallback.fill(future);
    await dialog.getByRole("button", { name: "Save wait", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    const region = page.getByRole("region", { name: "Wake when", exact: true });
    await expect(region.getByText("example/app#42 merges", { exact: true })).toBeVisible();
    await expect(region.getByText("Inspect the merged changes.", { exact: true })).toBeVisible();
    expect(daemon.store.snapshot(["item"]).item?.filter((i) => i.kind === "user") ?? []).toEqual(
      [],
    );
    await region.getByRole("button", { name: "Edit", exact: true }).click();
    const edit = page.getByRole("dialog", { name: "Edit wake condition" });
    await edit.getByLabel("Then", { exact: true }).selectOption("inbox");
    await edit.getByRole("button", { name: "Save wait", exact: true }).click();
    await expect(edit).not.toBeVisible();
    await page.reload();
    await expect(region.getByText("example/app#42 merges", { exact: true })).toBeVisible();
    expect((await new AxeBuilder({ page }).include(".chat-wakes").analyze()).violations).toEqual(
      [],
    );
    await page.screenshot({ path: "output/playwright/wakes-waiting.png", fullPage: true });
    await page.goto("http://127.0.0.1:5189/#sessions");
    const waitingSection = page.locator(".wake-waiting");
    await expect(waitingSection.locator("summary")).toHaveText("Waiting (1)");
    await expect(
      waitingSection.getByRole("button", { name: "Fixture", exact: true }),
    ).not.toBeVisible();
    await waitingSection.locator("summary").focus();
    await page.keyboard.press("Enter");
    expect((await new AxeBuilder({ page }).include(".wake-waiting").analyze()).violations).toEqual(
      [],
    );
    await waitingSection.getByRole("button", { name: "Fixture", exact: true }).click();
    await expect(region.getByText("example/app#42 merges", { exact: true })).toBeVisible();
    await region.getByRole("button", { name: "Bring back now" }).click();
    await expect(region.getByRole("button", { name: "Bring back now" })).toHaveCount(0);
    await expect(page.getByRole("article", { name: "Chat woke up" })).toBeVisible();
    await trigger.click();
    await dialog.getByLabel("Exact job", { exact: true }).selectOption("session|unit-tests");
    await dialog.getByRole("button", { name: "Save wait", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await region.getByRole("button", { name: "Cancel wait" }).click();
    await expect(region.getByRole("button", { name: "Cancel wait" })).toHaveCount(0);
    expect(
      daemon.store
        .snapshot(["wake"])
        .wake?.map((w) => w.status)
        .sort(),
    ).toEqual(["cancelled", "consumed"]);
    await trigger.click();
    await dialog.getByLabel("Exact job", { exact: true }).selectOption("session|unit-tests");
    await dialog.getByLabel("Then", { exact: true }).selectOption("resume");
    await dialog.getByLabel("Next step").fill("Inspect tests when resumed.");
    await dialog.getByRole("button", { name: "Save wait", exact: true }).click();
    await region.getByRole("button", { name: "Resume now", exact: true }).click();
    await expect
      .poll(() => daemon.store.snapshot(["item"]).item?.filter((i) => i.kind === "user").length)
      .toBe(1);
    expect(
      daemon.store.snapshot(["item"]).item?.find((i) => i.kind === "user")?.body,
    ).toMatchObject({ origin: "system", queueState: "queued" });
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    await daemon.close();
    f.close();
  }
});
