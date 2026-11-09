import { readFileSync } from "node:fs";
import { type Browser, chromium, type Page } from "@playwright/test";
import { transformSync } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The themed select is CSS plus a width helper on a native select, so it is checked in a real,
// headless Chromium: the engine supplies the picker, keyboard and accessibility behaviour.
const css = ["../../../tokens/tokens.css", "./base.css", "./select.css"]
  .map((file) => readFileSync(new URL(file, import.meta.url), "utf8"))
  .join("\n");
const fit = transformSync(readFileSync(new URL("./select-fit.ts", import.meta.url), "utf8"), {
  loader: "ts",
  format: "esm",
}).code.replace(/export\s*\{[^}]*\};?/, "");

const fruit = ["Apple", "Banana", "Cherry", "Date", "Elderberry", "Fig"];
function select(id: string, style: string, labels = fruit, disabled: number[] = []) {
  const options = labels
    .map(
      (label, i) =>
        `<option value="v${i}"${disabled.includes(i) ? " disabled" : ""}>${label}</option>`,
    )
    .join("");
  return `<select id="${id}" aria-label="${id}" style="position:fixed;${style}">${options}</select>`;
}

let browser: Browser;
let page: Page;
async function load(theme: "light" | "dark", body: string) {
  await page.setContent(
    `<html data-theme="${theme}"><head><style>${css}</style></head>
     <body class="zb"><div id="root" class="zb">${body}</div>
     <script>${fit}; window.changes = []; document.addEventListener("change", (e) => changes.push(e.target.value)); holdSelectWidths(document.getElementById("root"));</script>
     </body></html>`,
  );
}
const value = (id: string) => page.locator(`#${id}`).inputValue();
const isOpen = (id: string) => page.locator(`#${id}`).evaluate((el) => el.matches(":open"));

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 800, height: 600 } });
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

describe("themed select", () => {
  it("draws the control and its picker from the theme tokens in both themes", async () => {
    const colors: Record<string, string> = {};
    for (const theme of ["light", "dark"] as const) {
      await load(theme, select("s", "left:40px;top:40px;width:200px"));
      await page.locator("#s").click();
      const style = await page.locator("#s").evaluate((el) => {
        const token = (name: string) => {
          const probe = document.createElement("i");
          probe.style.color = `var(${name})`;
          document.body.append(probe);
          const color = getComputedStyle(probe).color;
          probe.remove();
          return color;
        };
        const picker = getComputedStyle(el, "::picker(select)");
        return {
          appearance: getComputedStyle(el).appearance,
          picker: picker.backgroundColor,
          popover: token("--zb-bg-popover"),
          control: getComputedStyle(el).backgroundColor,
          sunken: token("--zb-bg-sunken"),
        };
      });
      expect(style.appearance).toBe("base-select");
      expect(style.picker).toBe(style.popover);
      expect(style.control).toBe(style.sunken);
      colors[theme] = style.picker;
      await page.keyboard.press("Escape");
    }
    expect(colors.light).not.toBe(colors.dark);
  });

  it("supports arrows, Home/End, typeahead, Enter, Space and Escape, skipping disabled options", async () => {
    await load("dark", select("s", "left:40px;top:40px;width:200px", fruit, [1, 4]));
    const s = page.locator("#s");
    await s.focus();
    await page.keyboard.press("Space");
    expect(await isOpen("s")).toBe(true);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    expect(await value("s")).toBe("v2");
    expect(await isOpen("s")).toBe(false);
    expect(await s.evaluate((el) => document.activeElement === el)).toBe(true);

    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    expect(await value("s")).toBe("v5");
    await page.keyboard.press("Space");
    await page.keyboard.press("Home");
    await page.keyboard.press("Enter");
    expect(await value("s")).toBe("v0");

    await page.keyboard.press("Space");
    await page.keyboard.type("da");
    await page.keyboard.press("Enter");
    expect(await value("s")).toBe("v3");

    await page.keyboard.press("Space");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Escape");
    expect(await isOpen("s")).toBe(false);
    expect(await value("s")).toBe("v3");
    expect(await s.evaluate((el) => document.activeElement === el)).toBe(true);
    expect(await page.evaluate(() => (window as unknown as { changes: string[] }).changes)).toEqual(
      ["v2", "v5", "v0", "v3"],
    );
  });

  it("exposes a combobox with a listbox of options, disabled ones marked", async () => {
    await load("dark", select("Fruit", "left:40px;top:40px;width:200px", fruit, [1]));
    await page.locator("#Fruit").click();
    const cdp = await page.context().newCDPSession(page);
    const { nodes } = await cdp.send("Accessibility.getFullAXTree");
    await cdp.detach();
    const visible = nodes.filter((node) => !node.ignored);
    const combobox = visible.find((node) => node.role?.value === "combobox");
    expect(combobox?.name?.value).toBe("Fruit");
    expect(combobox?.properties?.find((p) => p.name === "expanded")?.value.value).toBe(true);
    expect(visible.some((node) => node.role?.value === "MenuListPopup")).toBe(true);
    const options = visible.filter((node) => node.role?.value === "option");
    expect(options.map((node) => node.name?.value)).toEqual(fruit);
    const banana = options.find((node) => node.name?.value === "Banana");
    expect(banana?.properties?.find((p) => p.name === "disabled")?.value.value).toBe(true);
    await page.locator("#Fruit").getByRole("option", { name: "Banana" }).click({ force: true });
    expect(await value("Fruit")).toBe("v0");
  });

  it("keeps the picker inside the window near its edges", async () => {
    const many = Array.from({ length: 40 }, (_, i) => `Option ${i}`);
    await load(
      "dark",
      [
        select("low", "right:4px;bottom:4px;width:160px"),
        select("high", "left:4px;top:4px;width:160px"),
        select("long", "left:300px;top:250px;width:160px", many),
      ].join(""),
    );
    for (const id of ["low", "high", "long"]) {
      await page.locator(`#${id}`).click();
      const box = await page.locator(`#${id}`).evaluate((el) => {
        const control = el.getBoundingClientRect();
        const option = (el as HTMLSelectElement).options[0]?.getBoundingClientRect();
        return { control, option, width: innerWidth, height: innerHeight };
      });
      if (id === "low") expect(box.option?.bottom).toBeLessThanOrEqual(box.control.top);
      else expect(box.option?.top).toBeGreaterThanOrEqual(box.control.bottom);
      expect(box.option?.left).toBeGreaterThanOrEqual(0);
      expect(box.option?.right).toBeLessThanOrEqual(box.width);
      expect(box.option?.top).toBeGreaterThanOrEqual(0);
      await page.keyboard.press("Escape");
    }
    // A long list scrolls inside the picker rather than running off the window.
    await page.locator("#long").click();
    const last = await page
      .locator("#long")
      .evaluate((el) => (el as HTMLSelectElement).options[39]?.getBoundingClientRect().top);
    expect(last).toBeGreaterThan(600);
    const inside = await page.locator("#long").evaluate((el) => {
      const option = (el as HTMLSelectElement).options[39];
      option?.scrollIntoView({ block: "nearest" });
      const rect = option?.getBoundingClientRect();
      return rect ? rect.bottom <= innerHeight : false;
    });
    expect(inside).toBe(true);
  });

  it("holds width-less selects at their widest option, like native selects", async () => {
    await load(
      "dark",
      `<div style="position:fixed;left:0;top:0">
        ${select("auto", "position:static", ["A", "A much longer option label"])}
        ${select("set", "position:static;width:120px", ["A", "A much longer option label"])}
      </div>
      <div id="later" style="display:none">${select("hidden", "position:static", ["B", "Another long option label"])}</div>`,
    );
    const width = (id: string) =>
      page.locator(`#${id}`).evaluate((el) => el.getBoundingClientRect().width);
    const first = await width("auto");
    await page.locator("#auto").selectOption("v1");
    expect(await width("auto")).toBe(first);
    await page.locator("#auto").selectOption("v0");
    expect(await width("auto")).toBe(first);
    expect(await width("set")).toBe(120);

    // New, longer labels widen it; a select shown later is fitted once it lays out.
    await page.locator("#auto").evaluate((el) => {
      el.append(new Option("An option far longer than the others were", "v2"));
    });
    expect(await width("auto")).toBeGreaterThan(first);
    await page.locator("#later").evaluate((el) => {
      (el as HTMLElement).style.display = "block";
    });
    // The fit waits for a resize observation, which lands after layout, not synchronously.
    await page.waitForFunction(() => document.getElementById("hidden")?.style.width !== "");
    const shown = await width("hidden");
    await page.locator("#hidden").selectOption("v0");
    expect(await width("hidden")).toBe(shown);
  });
});
