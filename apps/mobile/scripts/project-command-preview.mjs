/** Capture the actual prototype components through a browser host adapter, headlessly. */
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";

const mobile = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(mobile, "../..");
const out = resolve(root, "output/playwright/squad-focus");
const uiRequire = createRequire(resolve(root, "packages/ui/package.json"));
mkdirSync(out, { recursive: true });
const theme = readFileSync(resolve(mobile, "src/theme/index.ts"), "utf8").replace(
  'import { usePrefs } from "../state/prefs";',
  'const usePrefs = selector => selector({theme:"system"});',
);
const result = await build({
  stdin: {
    contents: `import React from 'react';import{createRoot}from'react-dom/client';import{Command}from'${resolve(mobile, "src/prototype/Command.tsx")}';createRoot(document.getElementById('root')).render(<Command onClose={()=>{}}/>);`,
    loader: "tsx",
    resolveDir: root,
  },
  write: false,
  bundle: true,
  platform: "browser",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"development"' },
  plugins: [
    {
      name: "prototype-native-preview",
      setup(builder) {
        builder.onResolve({ filter: /^react(?:\/.*)?$|^react-dom(?:\/.*)?$/ }, (args) => ({
          path: uiRequire.resolve(args.path),
        }));
        builder.onResolve({ filter: /^react-native$/ }, () => ({
          path: resolve(mobile, "scripts/project-command-preview-native.jsx"),
        }));
        builder.onResolve({ filter: /^react-native-safe-area-context$/ }, () => ({
          path: "insets",
          namespace: "preview",
        }));
        builder.onResolve({ filter: /^react-native-svg$/ }, () => ({
          path: "svg",
          namespace: "preview",
        }));
        builder.onResolve({ filter: /\/theme$/ }, () => ({ path: "theme", namespace: "preview" }));
        builder.onLoad({ filter: /.*/, namespace: "preview" }, (args) => ({
          contents:
            args.path === "theme"
              ? theme
              : args.path === "insets"
                ? "export const useSafeAreaInsets=()=>({top:16,bottom:16});"
                : `import React from 'react';export default ({children,accessible,...p})=><svg aria-hidden={accessible===false} {...p}>{children}</svg>;export const Path=p=><path {...p}/>;export const Rect=p=><rect {...p}/>;`,
          loader: "tsx",
          resolveDir: resolve(mobile, "src/theme"),
        }));
      },
    },
  ],
});
const bundle = result.outputFiles[0]?.text;
assert(bundle, "Preview bundle missing");
for (const font of ["geist-400", "geist-500", "geist-600", "geist-700", "geist-mono"])
  copyFileSync(resolve(mobile, `assets/fonts/${font}.ttf`), resolve(out, `${font}.ttf`));
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Squad focus · Component preview</title><style>${[400, 500, 600, 700].map((w) => `@font-face{font-family:Geist;src:url(geist-${w}.ttf);font-weight:${w}}`).join("")}@font-face{font-family:'Geist Mono';src:url(geist-mono.ttf)}html,body,#root{height:100%;margin:0;overflow:hidden}#root{display:flex;flex-direction:column}button:focus-visible{outline:2px solid currentColor;outline-offset:2px}*{box-sizing:border-box}</style></head><body><div id="root"></div><script src="bundle.js"></script></body></html>`;
const server = createServer((request, response) => {
  const path = new URL(request.url, "http://localhost").pathname;
  if (path === "/") {
    response.setHeader("Content-Type", "text/html");
    response.end(html);
    return;
  }
  if (path === "/bundle.js") {
    response.setHeader("Content-Type", "text/javascript");
    response.end(bundle);
    return;
  }
  if (/^\/geist-(?:400|500|600|700|mono)\.ttf$/.test(path)) {
    response.setHeader("Content-Type", "font/ttf");
    response.end(readFileSync(resolve(out, path.slice(1))));
    return;
  }
  response.statusCode = 404;
  response.end();
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const address = server.address();
assert(address && typeof address !== "string");
const origin = `http://127.0.0.1:${address.port}`;
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : { channel: "chrome" }),
  });
  const page = await browser.newPage({
    viewport: { width: 402, height: 874 },
    deviceScaleFactor: 2,
  });
  await page.clock.install({ time: new Date("2026-11-12T12:00:00Z") });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const button = (name) => page.getByRole("button", { name, exact: true });
  const options = async () => {
    await button("Prototype options").click();
    return page.getByRole("dialog");
  };
  const capture = async (name) => {
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    );
    await page.screenshot({ path: resolve(out, `${name}.png`) });
  };
  await page.goto(origin);
  await options();
  await button("Pause live sample").click();
  await button("Done").click();
  await capture("overview-dark");
  for (const width of [402, 390]) {
    await page.setViewportSize({ width, height: width === 402 ? 874 : 844 });
    const bottom = await page.getByRole("button", { name: /^Flaky test cleanup\./ }).boundingBox();
    const scroller = await page.locator("[data-scroll]").first().boundingBox();
    assert(
      bottom && scroller && bottom.y + bottom.height <= scroller.y + scroller.height + 1,
      `Sixth squad does not fit at ${width}px`,
    );
  }
  await capture("overview-390");
  await page.setViewportSize({ width: 402, height: 874 });
  await page.getByRole("button", { name: /^Return reminders\./ }).click();
  await button(
    "Open Return reminders details. Send a reminder before each rental is due.",
  ).waitFor();
  await capture("reminders-focus");
  await page.getByRole("button", { name: /^Agent 32,/ }).click();
  await capture("agent-sheet");
  await button("Send a message").click();
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Use a 24-hour reminder and report delivery failures.");
  await button("Send message").click();
  await page
    .getByText("Use a 24-hour reminder and report delivery failures.", { exact: true })
    .waitFor();
  await capture("chat-message");
  await button("Project overview").click();
  await button("Open Return reminders details. Send a reminder before each rental is due.").click();
  await page.getByRole("checkbox").first().click();
  await page.getByRole("checkbox").nth(1).click();
  await button("Orders →").click();
  await capture("orders");
  await button("Send order").click();
  await page.getByText("Sent to 2 agents", { exact: true }).waitFor();
  await capture("initiative-detail");
  await button("Unblock →").click();
  await page.getByRole("radio", { name: "24 hours" }).waitFor();
  await capture("unblock-question");
  await page.getByRole("textbox", { name: "Other", exact: true }).fill("36 hours");
  await options();
  await button("Resume live sample").click();
  await button("Done").click();
  await page.clock.fastForward(12000);
  await page.clock.fastForward(12000);
  assert.equal(
    await page.getByRole("textbox", { name: "Other", exact: true }).inputValue(),
    "36 hours",
    "A live request replaced the pending draft",
  );
  await page.getByText("9 remaining", { exact: true }).waitFor();
  await options();
  await button("Pause live sample").click();
  await button("Done").click();
  await page.getByRole("textbox", { name: "Other", exact: true }).fill("");
  await page.getByRole("radio", { name: "24 hours" }).click();
  await button("Send").click();
  await button("Approve the plan and auto-accept edits").waitFor();
  page.once("dialog", (dialog) => dialog.dismiss());
  await button("Approve the plan and auto-accept edits").click();
  await button("Approve the plan and auto-accept edits").waitFor();
  page.once("dialog", (dialog) => dialog.accept());
  await button("Approve the plan and auto-accept edits").click();
  // Drain every remaining question, command approval and plan without a back navigation.
  for (
    let n = 0;
    n < 10 && !(await page.getByText("All requests answered", { exact: true }).count());
    n++
  ) {
    if (await button("Allow once").count()) await button("Allow once").click();
    else if (await button("Approve the plan").count()) await button("Approve the plan").click();
    else {
      await page.getByRole("radio").first().click();
      await button("Send").click();
    }
  }
  await page.getByText("All requests answered", { exact: true }).waitFor();
  await capture("queue-complete");
  await options();
  await button("40-agent sample").click();
  await capture("forty-agents");
  await options();
  await button("Tiny sample").click();
  await capture("tiny-project");
  await options();
  await button("Empty sample").click();
  await page.getByText("No initiatives yet", { exact: true }).waitFor();
  await capture("empty-project");
  await page.goto(`${origin}?theme=light`);
  await options();
  await button("Pause live sample").click();
  await button("Done").click();
  await capture("overview-light");
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto(`${origin}?scale=3.2`);
  await options();
  await button("Pause live sample").click();
  await button("Done").click();
  assert(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    "Horizontal overflow at largest type",
  );
  const scroller = page.locator("[data-scroll]").first();
  assert(
    await scroller.evaluate((el) => el.clientHeight > 400),
    "Fixed chrome consumes the large-type scroll area",
  );
  await scroller.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await page.getByRole("button", { name: /^Flaky test cleanup\./ }).scrollIntoViewIfNeeded();
  await capture("largest-type-320");
  await page.getByRole("button", { name: /^Flaky test cleanup\./ }).click();
  await page.getByRole("button", { name: /^Agent 25,/ }).scrollIntoViewIfNeeded();
  await capture("largest-type-focused");
  await page.goto(origin);
  await options();
  await button("Pause live sample").click();
  await button("Done").click();
  await page.getByRole("button", { name: /^Agent 19,/ }).click();
  page.once("dialog", (dialog) => dialog.dismiss());
  await button("Stop agent").click();
  await page.getByRole("dialog").getByText("Needs you", { exact: true }).waitFor();
  page.once("dialog", (dialog) => dialog.accept());
  await button("Stop agent").click();
  await page.getByRole("dialog").getByText("Stopped by you", { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log(`Saved component previews and passed flow checks: ${out}`);
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}
