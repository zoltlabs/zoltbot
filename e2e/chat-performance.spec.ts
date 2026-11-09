import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { launch } from "./desktop.js";

interface Metrics {
  painted: number[];
  sourceToFrame: number[];
  emitted: number[];
  arrivals: number;
  usableShellMs?: number;
}

test("opens cached threads within 150 ms and paints sixty stream events per second within 50 ms", async () => {
  // Measure the shipped renderer; Vite's React development checks and source transforms
  // add instrumentation work that is outside the production latency budget.
  execFileSync("pnpm", ["build:ui"], { stdio: "pipe" });
  mkdirSync("output/performance", { recursive: true });
  rmSync("output/performance/chat.json", { force: true });
  const fixture = await launch("chat", undefined, {
      historyItems: 10000,
      uiUrl: "zoltbot://desktop/",
    }),
    { page } = fixture;
  try {
    await page.addInitScript(() => {
      const metrics: Metrics = { painted: [], sourceToFrame: [], emitted: [], arrivals: 0 };
      Object.defineProperty(window, "zoltPerformance", { value: metrics });
      const pending = new Map<number, { itemId: string; at: number; emitted: number }>();
      const original = window.WebSocket;
      window.WebSocket = class extends original {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          this.addEventListener("message", (message) => {
            const event = JSON.parse(String(message.data));
            if (event.method !== "event" || event.params?.type !== "item.stream") return;
            const item = event.params.payload;
            const markers = [...String(item?.body?.text ?? "").matchAll(/frame(\d{3}):(\d+)\|/g)];
            const last = markers.at(-1);
            if (!last) return;
            const index = Number(last[1]);
            if (pending.has(index) || index < metrics.arrivals) return;
            pending.set(index, {
              itemId: String(item.id),
              at: performance.now(),
              emitted: Number(last[2]),
            });
            metrics.arrivals++;
            scheduleFrame();
          });
        }
      };
      let scheduled = false;
      function scheduleFrame() {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => {
          scheduled = false;
          for (const [index, sample] of pending) {
            const row = document.querySelector<HTMLElement>(
              `[data-item-id="${CSS.escape(sample.itemId)}"]`,
            );
            const region = row?.closest(".chat-timeline");
            if (
              !row ||
              !region ||
              !row.textContent?.includes(`frame${String(index).padStart(3, "0")}:`)
            )
              continue;
            const rect = row.getBoundingClientRect(),
              viewport = region.getBoundingClientRect();
            if (
              rect.bottom <= viewport.top ||
              rect.top >= viewport.bottom ||
              rect.bottom > viewport.bottom + 2
            )
              continue;
            metrics.painted.push(performance.now() - sample.at);
            metrics.sourceToFrame.push(Date.now() - sample.emitted);
            metrics.emitted.push(sample.emitted);
            pending.delete(index);
          }
          if (pending.size) scheduleFrame();
        });
      }
      let measuringShell = false;
      const observe = new MutationObserver(() => {
        if (!measuringShell && document.body.textContent?.includes("Connected to local daemon")) {
          measuringShell = true;
          requestAnimationFrame(() => {
            metrics.usableShellMs = performance.now();
            observe.disconnect();
          });
        }
      });
      window.addEventListener("DOMContentLoaded", () =>
        observe.observe(document.body, { subtree: true, childList: true, characterData: true }),
      );
    });
    await page.reload();
    await expect(page.getByText("Connected to local daemon", { exact: true })).toBeVisible();
    const open = () =>
      page.evaluate(async () => {
        const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
          button.textContent?.includes("Chat verification"),
        );
        if (!button) throw new Error("fixture_thread_missing");
        const at = performance.now();
        await new Promise<void>((resolve, reject) => {
          let frame = 0;
          const timeout = setTimeout(() => {
            cancelAnimationFrame(frame);
            reject(new Error("thread_open_deadline"));
          }, 3000);
          const check = () => {
            const title = document.querySelector(".chat-header h1");
            const region = document.querySelector(".chat-timeline");
            const message = [...document.querySelectorAll(".chat-markdown")].find(
              (message) => message.textContent === "Ready to work.",
            );
            if (title?.textContent === "Chat verification" && region && message) {
              const rect = message.getBoundingClientRect(),
                viewport = region.getBoundingClientRect();
              if (
                rect.top >= viewport.top &&
                rect.bottom <= viewport.bottom + 2 &&
                region.scrollHeight - region.scrollTop - region.clientHeight < 4
              ) {
                clearTimeout(timeout);
                resolve();
                return;
              }
            }
            frame = requestAnimationFrame(check);
          };
          button.click();
          frame = requestAnimationFrame(check);
        });
        return performance.now() - at;
      });
    const coldOpen = await open();
    await page.getByRole("button", { name: "Overview", exact: true }).click();
    const warmOpen = await open();
    const editor = page.getByRole("textbox", { name: "Message Builder" });
    await editor.fill("benchmark60");
    await editor.press("Enter");
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (window as unknown as { zoltPerformance: Metrics }).zoltPerformance.painted.length,
          ),
        { timeout: 10000 },
      )
      .toBe(120);
    const metrics = await page.evaluate(
      () => (window as unknown as { zoltPerformance: Metrics }).zoltPerformance,
    );
    const maximum = Math.max(...metrics.painted),
      sourceMaximum = Math.max(...metrics.sourceToFrame);
    const report = {
      historyItems: 10000,
      rendererReloadToShellMs: metrics.usableShellMs,
      appLaunchToShellMs: fixture.startupMs,
      rendererFirstConnectedFrameMs: fixture.renderedStartupMs,
      startupStages: fixture.startupStages,
      coldOpenMs: coldOpen,
      warmOpenMs: warmOpen,
      events: metrics.arrivals,
      painted: metrics.painted.length,
      maxEventToFrameMs: maximum,
      maxSourceToFrameMs: sourceMaximum,
      emissionSpanMs: Math.max(...metrics.emitted) - Math.min(...metrics.emitted),
      slowestFrames: metrics.sourceToFrame
        .map((sourceToFrameMs, index) => ({
          index,
          sourceToFrameMs,
          arrivalToFrameMs: metrics.painted[index],
        }))
        .sort((a, b) => b.sourceToFrameMs - a.sourceToFrameMs)
        .slice(0, 5),
    };
    mkdirSync("output/performance", { recursive: true });
    writeFileSync("output/performance/chat.json", JSON.stringify(report, null, 2));
    expect(fixture.startupMs, JSON.stringify(report)).toBeLessThan(2000);
    expect(fixture.renderedStartupMs, JSON.stringify(report)).toBeGreaterThanOrEqual(0);
    expect(fixture.renderedStartupMs, JSON.stringify(report)).toBeLessThan(2000);
    expect(metrics.usableShellMs, JSON.stringify(report)).toBeLessThan(2000);
    expect(sourceMaximum, JSON.stringify(report)).toBeLessThan(50);
    expect(coldOpen, JSON.stringify(report)).toBeLessThan(150);
    expect(warmOpen, JSON.stringify(report)).toBeLessThan(150);
    expect(maximum, JSON.stringify(report)).toBeLessThan(50);
    expect(report.emissionSpanMs).toBeGreaterThan(1900);
    expect(report.emissionSpanMs).toBeLessThan(2100);
    expect(Math.min(...metrics.sourceToFrame)).toBeGreaterThanOrEqual(0);
  } finally {
    await fixture.cleanup();
  }
});
