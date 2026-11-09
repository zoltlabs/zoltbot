import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

// Safe fixed fixture only. No Electron, remote resources or foreground windows.
const output = path.resolve(".cache/artifacts-spike/canvas");
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  executablePath: path.resolve(
    ".cache/browser-spike/browsers/chromium_headless_shell-1252/chrome-headless-shell-mac-arm64/chrome-headless-shell",
  ),
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.route("**/*", (route) => route.abort());
  const readings = [];
  for (const live of [12, 3]) {
    const start = performance.now();
    await page.setContent(
      `<main aria-label="Artboards" tabindex="0" style="overflow:auto;height:850px"><div id="canvas" style="display:grid;grid-template-columns:repeat(4,390px);gap:20px;transform-origin:0 0">${Array.from({ length: 12 }, (_, i) => `<section aria-label="Screen ${i + 1}"><h2>Screen ${i + 1}</h2>${i < live ? `<iframe title="Screen ${i + 1}" sandbox="allow-scripts" width="390" height="600" srcdoc="<h1>Screen ${i + 1}</h1><button>Continue</button>"></iframe>` : `<div style="width:390px;height:600px;background:#eee">Thumbnail ${i + 1}</div>`}</section>`).join("")}</div></main>`,
    );
    const frames = await page.locator("iframe").count();
    const initialRenderMs = performance.now() - start;
    const deltas = await page.evaluate(async () => {
      const samples: number[] = [];
      let previous = performance.now();
      for (let i = 0; i < 60; i++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const now = performance.now();
        samples.push(now - previous);
        previous = now;
        const canvas = document.getElementById("canvas");
        if (canvas) canvas.style.transform = `translate(${i}px,${i}px) scale(${1 - i / 200})`;
      }
      return samples;
    });
    readings.push({
      initialRenderMs,
      screens: 12,
      liveFrames: frames,
      elapsedMs: performance.now() - start,
      worstAnimationFrameMs: Math.max(...deltas),
      averageAnimationFrameMs: deltas.reduce((a, b) => a + b, 0) / deltas.length,
    });
    await page.screenshot({ path: path.join(output, `${live}-live.png`) });
  }
  writeFileSync(path.join(output, "measurements.json"), JSON.stringify(readings, null, 2));
  console.log(JSON.stringify(readings));
} finally {
  await browser.close();
}
