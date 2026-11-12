import { expect, type Page, test } from "@playwright/test";
import type { ZoltClient } from "../../packages/view-api/src/client.js";
import { serveView } from "../../tools/view-dev/src/server.js";

// The design pass on the built-in command map, checked against sample data in headless
// Chromium. WebGL runs in software here, so these tests count draw calls and triangles and
// never measure frame rate.
interface Stats {
  calls: number;
  triangles: number;
  frames: number;
  level: string;
  choice: string;
  passes: string[];
  shadows: boolean;
  zoom: number;
  far: boolean;
  units: number;
  animated: boolean;
}
interface MapWindow {
  zolt: ZoltClient;
  CommandMap: {
    scene: {
      stats(): Stats;
      intro?: number;
      moving?: boolean;
      camera: { now: { x: number; z: number }; goal: { x: number; z: number } };
    };
  };
}
const stats = (page: Page) =>
  page.evaluate(() => (window as unknown as MapWindow).CommandMap.scene.stats());
const settled = (page: Page) =>
  page.waitForFunction(
    () => {
      const scene = (window as unknown as MapWindow).CommandMap?.scene;
      return scene && scene.stats().frames > 2 && scene.intro === undefined && !scene.moving;
    },
    null,
    { timeout: 90000 },
  );
// Draws at least `count` more frames at the current settings.
async function frames(page: Page, count: number) {
  const from = (await stats(page)).frames;
  await page.evaluate(() =>
    (window as unknown as { CommandMap: { scene: { redraw(): void } } }).CommandMap.scene.redraw(),
  );
  await page.waitForFunction(
    (target) => (window as unknown as MapWindow).CommandMap.scene.stats().frames >= target,
    from + count,
    { timeout: 90000 },
  );
}
async function open(page: Page, hash = "", permissions?: string[]) {
  const server = await serveView("packages/views/command-map");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  if (permissions)
    await page.route("**/_host/v1/mock.js", async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        body: (await response.text()).replace(
          /window\.zoltMockPermissions=\[[^\]]*\]/,
          `window.zoltMockPermissions=${JSON.stringify(permissions)}`,
        ),
      });
    });
  await page.goto(server.url + hash);
  await page.evaluate(() => (window as unknown as MapWindow).zolt.ready);
  return { server, errors };
}
test.setTimeout(180000);

test("draws 200 chats within the draw-call and triangle budget at every graphics level", async ({
  page,
}) => {
  const { server, errors } = await open(page, "#chats=200");
  try {
    await settled(page);
    const first = await stats(page);
    expect(first).toMatchObject({ units: 200, far: false, zoom: 1 });
    // Headless Chromium renders in software, so "Auto" starts at the low level.
    expect(first).toMatchObject({ choice: "auto", level: "low", passes: [], shadows: false });
    const budget = async (level: string) => {
      await page.getByLabel("Graphics").selectOption(level);
      await frames(page, 2);
      const now = await stats(page);
      expect(now.level).toBe(level);
      expect(now.calls, `${level} draw calls`).toBeLessThanOrEqual(300);
      expect(now.triangles, `${level} triangles`).toBeLessThanOrEqual(500000);
      test.info().annotations.push({
        type: "budget",
        description: `${level}: ${now.calls} draw calls, ${now.triangles} triangles for 200 chats at zoom ${now.zoom}`,
      });
      console.log(test.info().annotations.at(-1)?.description);
      return now;
    };
    expect(await budget("high")).toMatchObject({
      passes: ["occlusion", "bloom", "blurAcross", "blurDown"],
      shadows: true,
    });
    expect(await budget("medium")).toMatchObject({ passes: ["bloom"], shadows: true });
    expect(await budget("low")).toMatchObject({ passes: [], shadows: false });
    // The choice is saved through storage and applied on the next load.
    await page.getByLabel("Graphics").selectOption("medium");
    await expect
      .poll(() => page.evaluate(() => (window as unknown as MapWindow).zolt.storage.get()))
      .toMatchObject({ quality: "medium" });
    await page.reload();
    await settled(page);
    expect(await stats(page)).toMatchObject({ choice: "medium", level: "medium" });
    await expect(page.getByLabel("Graphics")).toHaveValue("medium");
    // Zoomed out to the whole map, units become simple markers and stay within budget.
    await page.getByRole("button", { name: "Show the whole map" }).click();
    await expect.poll(async () => (await stats(page)).far, { timeout: 60000 }).toBe(true);
    await settled(page);
    const whole = await stats(page);
    expect(whole.calls).toBeLessThanOrEqual(300);
    expect(whole.triangles).toBeLessThanOrEqual(500000);
    expect(errors).toEqual([]);
  } finally {
    await server.close();
  }
});

test("stops drawing while hidden and idles when nothing moves", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const { server, errors } = await open(page);
  try {
    await settled(page);
    // With reduced motion nothing animates, so no frames are drawn once the map is still.
    await page.getByRole("button", { name: "Pause updates", exact: true }).click();
    await page.waitForTimeout(700);
    const still = await stats(page);
    await page.waitForTimeout(1200);
    expect((await stats(page)).frames).toBe(still.frames);
    const setHidden = (hidden: boolean) =>
      page.evaluate((hidden) => {
        Object.defineProperty(document, "hidden", { value: hidden, configurable: true });
        document.dispatchEvent(new Event("visibilitychange"));
      }, hidden);
    await setHidden(true);
    await page.getByRole("button", { name: "Zoom in" }).click();
    await page.waitForTimeout(600);
    expect((await stats(page)).frames).toBe(still.frames);
    await setHidden(false);
    await expect.poll(async () => (await stats(page)).frames).toBeGreaterThan(still.frames);
    expect(errors).toEqual([]);
  } finally {
    await server.close();
  }
});

test("honors reduced motion: no intro, no easing, no particles, static marks with text labels", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const { server, errors } = await open(page);
  try {
    const facts = await page.evaluate(() => (window as unknown as MapWindow).zolt.ready);
    expect(facts.reducedMotion).toBe(true);
    await settled(page);
    expect(await stats(page)).toMatchObject({ animated: false });
    expect(
      await page.evaluate(() => (window as unknown as MapWindow).CommandMap.scene.intro),
    ).toBeUndefined();
    // Jumping to an alert moves the camera in one frame.
    await page.getByRole("button", { name: "Next alert", exact: true }).click();
    await frames(page, 1);
    const camera = await page.evaluate(
      () => (window as unknown as MapWindow).CommandMap.scene.camera,
    );
    expect(camera.now).toEqual(camera.goal);
    await expect(page.locator("#live")).toHaveText("Check the result needs you");
    // Every state is named in the list, and the unit on the map carries the same words.
    for (const label of [
      "Check the result — Needs you",
      "Tidy the styles — Done",
      "Plan the next release — Later",
      "Update the dependencies — Idle ⚠ Warning",
    ])
      await expect(page.getByText(label, { exact: true })).toBeVisible();
    await expect(page.getByText(/^Build the page — (Working|Done|Idle)$/)).toBeVisible();
    await expect(page.locator('.unit[data-chat="demo-check"]')).toHaveAccessibleName(
      /^Check the result, needs you, waiting .+\. Open chat$/,
    );
    await expect(page.locator('.unit[data-chat="demo-check"] .wait')).toHaveText(/now|min/);
    expect(errors).toEqual([]);
  } finally {
    await server.close();
  }
});

test("works with read alone: the map, list, alerts, groups and saved settings, without orders or answers", async ({
  page,
}) => {
  const { server, errors } = await open(page, "", ["read"]);
  try {
    expect(await page.evaluate(() => (window as unknown as MapWindow).zolt.granted)).toEqual([
      "read",
    ]);
    await settled(page);
    expect((await stats(page)).units).toBe(6);
    await expect(page.locator("#error")).toHaveText("");
    await expect(page.getByRole("heading", { name: "Orders", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Next alert", exact: true }).click();
    await expect(
      page.getByRole("checkbox", { name: "Check the result — Needs you", exact: true }),
    ).toBeChecked();
    // The request is shown for reading; answering it takes the owner to the chat.
    await expect(page.getByRole("heading", { name: "Run the checks?", exact: true })).toBeVisible();
    await expect(page.locator("#actions").getByText("pnpm test", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Allow once", exact: true })).toHaveCount(0);
    const opened = page.evaluate(
      () =>
        new Promise((resolve) =>
          window.addEventListener("zolt:mock-open", (event) =>
            resolve((event as CustomEvent).detail),
          ),
        ),
    );
    await page.locator("#actions").getByRole("button", { name: "Open chat", exact: true }).click();
    expect(await opened).toEqual({ chatId: "demo-check" });
    // Control groups and the sound setting still save, because storage needs only read.
    await page.getByRole("button", { name: "Save group 2", exact: true }).click();
    await page.getByRole("button", { name: "Sound", exact: true }).click();
    await expect(page.getByRole("button", { name: "Sound", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect
      .poll(() => page.evaluate(() => (window as unknown as MapWindow).zolt.storage.get()))
      .toMatchObject({ groups: { 2: ["demo-check"] }, sound: true });
    await page
      .getByRole("checkbox", { name: "Check the result — Needs you", exact: true })
      .uncheck();
    await page.getByRole("button", { name: "Select group 2", exact: true }).click();
    await expect(
      page.getByRole("checkbox", { name: "Check the result — Needs you", exact: true }),
    ).toBeChecked();
    const code = await page.evaluate(async () => {
      try {
        await (window as unknown as MapWindow).zolt.chats.send({
          chatIds: ["demo-check"],
          text: "x",
        });
      } catch (error) {
        return (error as Error & { code: string }).code;
      }
    });
    expect(code).toBe("not_granted");
    expect(errors).toEqual([]);
  } finally {
    await server.close();
  }
});

test("points edge alerts at off-screen chats that need you, with how long each has waited", async ({
  page,
}) => {
  const { server, errors } = await open(page, "#chats=200");
  try {
    await settled(page);
    const alerts = page.locator(".edge-alert:not([hidden])");
    await expect(alerts.first()).toBeVisible();
    expect(await alerts.count()).toBeLessThanOrEqual(6);
    await expect(alerts.first()).toHaveAccessibleName(/^Find .+, needs you, waiting \d+ minutes?$/);
    await expect(alerts.first().locator(".wait")).toHaveText(/^\d+ min$/);
    const name = await alerts.first().locator(".unit-name").textContent();
    await alerts.first().click();
    await settled(page);
    await expect(page.locator(".unit.selected")).toContainText(name ?? "missing");
    await expect(page.locator("#chats li.selected")).toHaveCount(1);
    expect(errors).toEqual([]);
  } finally {
    await server.close();
  }
});

for (const scheme of ["light", "dark"] as const)
  test(`meets AA contrast for every HUD and panel text pair in the ${scheme} theme`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    const { server } = await open(page, "#chats=200");
    try {
      await settled(page);
      await page.getByRole("button", { name: "Next alert", exact: true }).click();
      await page.getByRole("button", { name: "Save group 1", exact: true }).click();
      await frames(page, 1);
      const failures = await page.evaluate(() => {
        const parse = (value: string) => (value.match(/[0-9.]+/g) ?? []).map(Number);
        const luminance = ([r = 0, g = 0, b = 0]: number[]) => {
          const channel = (value: number) => {
            const c = value / 255;
            return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
          };
          return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
        };
        const ratio = (a: number[], b: number[]) => {
          const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
          return (hi + 0.05) / (lo + 0.05);
        };
        // The color actually behind an element: its nearest opaque background, with any
        // translucent layers above it blended in.
        const backdrop = (element: Element) => {
          const layers: number[][] = [];
          for (let node: Element | null = element; node; node = node.parentElement) {
            const color = parse(getComputedStyle(node).backgroundColor);
            if (color.length === 3 || (color[3] ?? 0) > 0) layers.push(color);
            if (color.length === 3 || color[3] === 1) break;
          }
          return layers.reduceRight<number[]>(
            (under, layer) => {
              const alpha = layer[3] ?? 1;
              return [0, 1, 2].map((i) => (layer[i] ?? 0) * alpha + (under[i] ?? 0) * (1 - alpha));
            },
            [255, 255, 255],
          );
        };
        const failures: string[] = [];
        const seen = new Map<string, number>();
        const visible = (element: Element) => {
          const box = element.getBoundingClientRect();
          return box.width > 0 && box.height > 0 && !element.closest("[hidden]");
        };
        for (const element of document.querySelectorAll(".map *, .panel *")) {
          if (!visible(element)) continue;
          const style = getComputedStyle(element),
            disabled = element.closest(":disabled") !== null,
            behind = backdrop(element);
          const text = [...element.childNodes].some(
            (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
          );
          if (text && !disabled) {
            const value = ratio(parse(style.color), behind),
              key = `text ${style.color} on ${behind.map(Math.round)}`;
            if (value < 4.5 && !seen.has(key))
              failures.push(
                `${key} = ${value.toFixed(2)} (${element.className || element.tagName})`,
              );
            seen.set(key, value);
          }
          if (element instanceof SVGSVGElement && element.classList.contains("icon") && !disabled) {
            const value = ratio(parse(style.color), behind),
              key = `icon ${style.color} on ${behind.map(Math.round)}`;
            if (value < 3 && !seen.has(key))
              failures.push(`${key} = ${value.toFixed(2)} (${element.getAttribute("class")})`);
            seen.set(key, value);
          }
          if (element.matches("button, select, textarea, input[type=text]") && !disabled) {
            const outside = element.parentElement ? backdrop(element.parentElement) : behind,
              value = ratio(parse(style.borderTopColor), outside),
              key = `border ${style.borderTopColor} on ${outside.map(Math.round)}`;
            if (value < 3 && !seen.has(key))
              failures.push(
                `${key} = ${value.toFixed(2)} (${element.className || element.tagName})`,
              );
            seen.set(key, value);
          }
        }
        return {
          failures,
          pairs: seen.size,
          lowestText: Math.min(
            ...[...seen].filter(([key]) => key.startsWith("text")).map(([, value]) => value),
          ),
          lowestOther: Math.min(
            ...[...seen].filter(([key]) => !key.startsWith("text")).map(([, value]) => value),
          ),
        };
      });
      test.info().annotations.push({
        type: "contrast",
        description: `${scheme}: ${failures.pairs} distinct color pairs measured; lowest text contrast ${failures.lowestText.toFixed(2)}, lowest icon or border contrast ${failures.lowestOther.toFixed(2)}`,
      });
      console.log(test.info().annotations.at(-1)?.description);
      expect(failures.pairs).toBeGreaterThan(8);
      expect(failures.failures).toEqual([]);
      // Keyboard focus is visible on HUD controls.
      await page.getByRole("button", { name: "Zoom in" }).focus();
      await page.keyboard.press("Tab");
      const outline = await page.evaluate(() => {
        const style = getComputedStyle(document.activeElement as Element);
        return { width: Number.parseFloat(style.outlineWidth), style: style.outlineStyle };
      });
      expect(outline.style).toBe("solid");
      expect(outline.width).toBeGreaterThanOrEqual(2);
    } finally {
      await server.close();
    }
  });

test("selects with the pointer and keeps keyboard control of groups and the camera", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const { server, errors } = await open(page);
  try {
    await settled(page);
    await page.getByRole("button", { name: "Pause updates", exact: true }).click();
    const spot = (id: string) =>
      page.evaluate((id) => {
        const scene = (
          window as unknown as {
            CommandMap: {
              scene: { overlay: { units: { chat: { id: string }; sx: number; sy: number }[] } };
            };
          }
        ).CommandMap.scene;
        const unit = scene.overlay.units.find((item) => item.chat.id === id),
          box = document.querySelector("#map")?.getBoundingClientRect();
        return { x: (box?.left ?? 0) + (unit?.sx ?? 0), y: (box?.top ?? 0) + (unit?.sy ?? 0) };
      }, id);
    // Hover names the unit; Shift+click selects it; a plain click opens its chat.
    const notes = await spot("demo-review");
    await expect(page.locator('.unit[data-chat="demo-review"]')).toBeHidden();
    await page.mouse.move(notes.x, notes.y);
    await expect(page.locator('.unit[data-chat="demo-review"]')).toBeVisible();
    await page.keyboard.down("Shift");
    await page.mouse.click(notes.x, notes.y);
    await page.keyboard.up("Shift");
    await expect(
      page.getByRole("checkbox", { name: "Tidy the styles — Done", exact: true }),
    ).toBeChecked();
    const opened = page.evaluate(
      () =>
        new Promise((resolve) =>
          window.addEventListener("zolt:mock-open", (event) =>
            resolve((event as CustomEvent).detail),
          ),
        ),
    );
    await page.mouse.click(notes.x, notes.y);
    expect(await opened).toEqual({ chatId: "demo-review" });
    // Dragging a box selects every unit inside it.
    const a = await spot("demo-check"),
      b = await spot("demo-build");
    await page.mouse.move(Math.min(a.x, b.x) - 100, Math.max(a.y, b.y) + 30);
    await page.mouse.down();
    await page.mouse.move(Math.max(a.x, b.x) + 100, Math.min(a.y, b.y) - 20, { steps: 4 });
    await page.mouse.up();
    await expect(page.locator("#chats li.selected")).not.toHaveCount(0);
    await expect(
      page.getByRole("checkbox", { name: "Check the result — Needs you", exact: true }),
    ).toBeChecked();
    await expect(page.getByRole("checkbox", { name: /^Build the page — / })).toBeChecked();
    // Keys: save and recall a group, clear with Escape, move and zoom the camera.
    await page.mouse.move(5, 300);
    await page.keyboard.press("Shift+Digit3");
    await page.keyboard.press("Escape");
    await expect(page.locator("#chats li.selected")).toHaveCount(0);
    await page.keyboard.press("Digit3");
    await expect(
      page.getByRole("checkbox", { name: "Check the result — Needs you", exact: true }),
    ).toBeChecked();
    const before = await stats(page);
    await page.keyboard.press("Equal");
    await frames(page, 1);
    expect((await stats(page)).zoom).toBeGreaterThan(before.zoom);
    await page.keyboard.press("0");
    await frames(page, 1);
    await page.keyboard.press("Space");
    await expect(page.locator("#live")).toHaveText("Check the result needs you");
    expect(errors).toEqual([]);
  } finally {
    await server.close();
  }
});
