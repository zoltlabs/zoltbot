// Design checks shared by the kit gallery, the broken fixtures and every app page. Each returns
// a list of problems instead of failing, so one run reports everything on a screen at once.
import { expect, type Locator, type Page } from "@playwright/test";

/** Window sizes every page is checked at. */
export const WINDOW_SIZES = [
  { width: 960, height: 640 },
  { width: 1280, height: 820 },
  { width: 1680, height: 1050 },
] as const;

/**
 * Problems with an open overlay: any part outside the viewport, or a corner or its center
 * covered by something else.
 */
export async function overlayProblems(page: Page, overlay: Locator, name: string) {
  const problems: string[] = [];
  const box = await overlay.boundingBox();
  const viewport = page.viewportSize();
  if (!box || !viewport) return [`${name}: not visible`];
  if (box.x < 0) problems.push(`${name}: left edge off screen`);
  if (box.y < 0) problems.push(`${name}: top edge off screen`);
  if (box.x + box.width > viewport.width) problems.push(`${name}: right edge off screen`);
  if (box.y + box.height > viewport.height) problems.push(`${name}: bottom edge off screen`);
  const covered = await overlay.evaluate((element) => {
    // Tooltips ignore the pointer; probe them as if they didn't.
    const style = (element as HTMLElement).style;
    const pointerEvents = style.pointerEvents;
    style.pointerEvents = "auto";
    const rect = element.getBoundingClientRect();
    // Probe inside the rounded corners: the corner of the box itself is outside the shape.
    const radius = Number.parseFloat(getComputedStyle(element).borderTopLeftRadius) || 0;
    const inset = Math.max(3, Math.ceil(radius / 2) + 2);
    const points = [
      [rect.left + inset, rect.top + inset],
      [rect.right - inset, rect.top + inset],
      [rect.left + inset, rect.bottom - inset],
      [rect.right - inset, rect.bottom - inset],
      [rect.left + rect.width / 2, rect.top + rect.height / 2],
    ];
    const result = points
      .filter(([x, y]) => {
        // A point outside the window has no element; the edge checks above report it.
        if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false;
        const hit = document.elementFromPoint(x, y);
        return !hit || !element.contains(hit);
      })
      .map(([x, y]) => `${Math.round(x)},${Math.round(y)}`);
    style.pointerEvents = pointerEvents;
    return result;
  });
  if (covered.length) problems.push(`${name}: covered at ${covered.join(" ")}`);
  return problems;
}

/** Fails with every problem an overlay has. */
export async function expectFullyVisible(page: Page, overlay: Locator, name: string) {
  await expect(overlay, name).toBeVisible();
  expect(await overlayProblems(page, overlay, name)).toEqual([]);
}

/**
 * Opens the overlay behind `trigger`, checks it, closes it with Escape and checks focus goes
 * back to the trigger. Overlays are found by `data-kit-overlay`, which every kit overlay sets;
 * an overlay that isn't from the kit doesn't count as opening.
 */
export async function triggerProblems(page: Page, trigger: Locator, name: string) {
  const before = await page.locator("[data-kit-overlay]").count();
  // Controls revealed on hover, such as a message's toolbar, show once the pointer is over them.
  await trigger.hover({ force: true });
  try {
    await trigger.click({ timeout: 5_000 });
  } catch {
    return [`${name}: can't be clicked; something covers it`];
  }
  const overlay = page.locator("[data-kit-overlay]").last();
  try {
    await expect(page.locator("[data-kit-overlay]")).toHaveCount(before + 1, { timeout: 2_000 });
  } catch {
    return [`${name}: opened no kit overlay`];
  }
  const problems = await overlayProblems(page, overlay, name);
  await page.keyboard.press("Escape");
  if (!(await overlay.isHidden())) {
    try {
      await expect(overlay).toBeHidden({ timeout: 2_000 });
    } catch {
      problems.push(`${name}: stays open after Escape`);
      return problems;
    }
  }
  try {
    await expect(trigger).toBeFocused({ timeout: 2_000 });
  } catch {
    problems.push(`${name}: focus doesn't return to the trigger`);
  }
  return problems;
}

/** Every visible, enabled control on the page that opens a menu, listbox or dialog. */
export async function overlayTriggers(page: Page): Promise<{ locator: Locator; name: string }[]> {
  const triggers = page.locator(
    "[aria-haspopup]:not([disabled]):not([aria-disabled='true']):visible",
  );
  const count = await triggers.count();
  const found: { locator: Locator; name: string }[] = [];
  for (let index = 0; index < count; index++) {
    const locator = triggers.nth(index);
    const name =
      (await locator.getAttribute("aria-label")) ||
      (await locator.innerText()).trim().split("\n")[0] ||
      `trigger ${index + 1}`;
    found.push({ locator, name });
  }
  return found;
}

/**
 * Layout problems on the current screen:
 * - horizontal scroll on the page or in a scrolling panel
 * - text cut off by overflow or an ellipsis, with no title or accessible name to read it
 * - controls smaller than 24×24 CSS pixels (WCAG 2.2 target size), except links inside text;
 *   an input's label counts as part of its target
 * - visible sibling controls or text blocks that overlap
 */
export async function layoutProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const problems: string[] = [];
    const describe = (element: Element) => {
      const label =
        element.getAttribute("aria-label") ||
        (element.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
      const classes = [...element.classList].slice(0, 2).join(".");
      return `${element.tagName.toLowerCase()}${classes ? `.${classes}` : ""} "${label}"`;
    };
    const visible = (element: Element) => {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      const style = getComputedStyle(element);
      return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
    };

    const root = document.scrollingElement ?? document.documentElement;
    if (root.scrollWidth > root.clientWidth + 1)
      problems.push(`page scrolls sideways by ${root.scrollWidth - root.clientWidth}px`);

    // The app's body clips overflow instead of scrolling, so also look for content that runs
    // past the window's right edge without a panel of its own clipping it first.
    const pastEdge = (element: Element) => {
      if (element.getBoundingClientRect().right <= innerWidth + 1) return false;
      for (
        let node = element.parentElement;
        node && node !== document.body;
        node = node.parentElement
      ) {
        const overflow = getComputedStyle(node).overflowX;
        // A panel narrower than the window clips it on purpose; the app's full-width root doesn't.
        if (overflow !== "visible" && node.getBoundingClientRect().right < innerWidth - 1)
          return false;
      }
      return true;
    };

    for (const element of document.body.querySelectorAll("*")) {
      if (!visible(element)) continue;
      if (
        !element.closest("[data-kit-overlay], [data-scrolls-sideways]") &&
        pastEdge(element) &&
        !(element.parentElement && pastEdge(element.parentElement))
      )
        problems.push(
          `${describe(element)} runs past the window's right edge, so it scrolls sideways or is cut off`,
        );
      const style = getComputedStyle(element);
      const scrollsX = style.overflowX === "auto" || style.overflowX === "scroll";
      // Rows meant to scroll sideways, such as tab strips, say so with this attribute.
      if (
        scrollsX &&
        !element.closest("[data-scrolls-sideways]") &&
        element.scrollWidth > element.clientWidth + 1
      )
        problems.push(`${describe(element)} scrolls sideways`);

      const clips = style.overflowX === "hidden" || style.textOverflow === "ellipsis";
      const hasOwnText = [...element.childNodes].some(
        (node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim(),
      );
      if (clips && hasOwnText && element.scrollWidth > element.clientWidth + 1) {
        const readable =
          element.closest("[title]") ||
          element.closest("[aria-label]") ||
          element.closest("[aria-describedby]");
        if (!readable) problems.push(`${describe(element)} is cut off with no way to read it`);
      }
    }

    const controls = document.body.querySelectorAll<HTMLElement>(
      "button, [role='button'], [role='menuitem'], [role='option'], [role='tab'], [role='switch'], input:not([type='hidden']), select, a[href]",
    );
    for (const control of controls) {
      if (!visible(control) || control.closest("[aria-hidden='true']")) continue;
      // Links inside a sentence are exempt from the target size rule.
      if (control.tagName === "A" && control.closest("p, li")) continue;
      // An input covered by its own styled control, such as a switch, is sized by that control.
      if (control.tagName === "INPUT" && getComputedStyle(control).opacity === "0") continue;
      // Clicking an input's label focuses or toggles the input, so the label is part of its target.
      const labels = control instanceof HTMLInputElement ? [...(control.labels ?? [])] : [];
      const rect = [control, ...labels]
        .map((element) => element.getBoundingClientRect())
        .reduce((largest, next) =>
          next.width * next.height > largest.width * largest.height ? next : largest,
        );
      if (rect.width < 24 || rect.height < 24)
        problems.push(
          `${describe(control)} is ${Math.round(rect.width)}×${Math.round(rect.height)}, under 24×24`,
        );
    }

    const blocks = [...document.body.querySelectorAll("*")].filter((element) => {
      if (!visible(element) || element.closest("[data-kit-overlay], [aria-hidden='true']"))
        return false;
      const style = getComputedStyle(element);
      if (style.position === "absolute" || style.position === "fixed") return false;
      return element.matches("button, input, textarea, select, a[href], h1, h2, h3, p, label");
    });
    const byParent = new Map<Element, Element[]>();
    for (const block of blocks) {
      const parent = block.parentElement;
      if (!parent) continue;
      byParent.set(parent, [...(byParent.get(parent) ?? []), block]);
    }
    for (const siblings of byParent.values()) {
      for (let i = 0; i < siblings.length; i++) {
        for (let j = i + 1; j < siblings.length; j++) {
          const a = siblings[i]?.getBoundingClientRect();
          const b = siblings[j]?.getBoundingClientRect();
          if (!a || !b) continue;
          const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (width > 2 && height > 2)
            problems.push(
              `${describe(siblings[i] as Element)} overlaps ${describe(siblings[j] as Element)}`,
            );
        }
      }
    }
    return [...new Set(problems)];
  });
}
