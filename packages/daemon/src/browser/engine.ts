// B2: the browser the daemon launches and owns. The agent's CLI attaches to it through a named
// pipe; the daemon keeps its own connection for frames and (B3) the owner's input.
import { execFile } from "node:child_process";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { CONSENT_SCRIPT, type ConsentChoice } from "./consent.js";
import { cliPath } from "./runtime.js";

export interface EngineFrame {
  data: Buffer;
  width: number;
  height: number;
}

export interface EnginePage {
  url(): string;
  /** Starts JPEG frames; resolves to a stop function. */
  frames(
    onFrame: (frame: EngineFrame) => void,
    size: { width: number },
  ): Promise<() => Promise<void>>;
  /** B3: the owner's input, in page CSS pixels. */
  mouse(event: {
    type: "move" | "down" | "up" | "wheel";
    x: number;
    y: number;
    button?: "left" | "right" | "middle";
    deltaX?: number;
    deltaY?: number;
  }): Promise<void>;
  key(event: { type: "down" | "up" | "text"; key: string }): Promise<void>;
  /** Runs a function in the page; used by B4–B6 checks. */
  evaluate<T>(fn: string): Promise<T>;
  onClose(listener: () => void): void;
  onLoad(listener: () => void): void;
}

export interface EngineBrowser {
  /** Where the CLI attaches (a named pipe path). */
  endpoint: string;
  pages(): EnginePage[];
  onPage(listener: (page: EnginePage) => void): void;
  /** Reports pointer presses inside pages, so the panel can show where the agent clicked. */
  onPointer(listener: (page: EnginePage, point: { x: number; y: number }) => void): void;
  close(): Promise<void>;
}

export interface BrowserEngine {
  launch(options: {
    userDataDir: string;
    headless: boolean;
    title: string;
    /** B5: what to do with a cookie banner on a page, asked once per frame that shows one. */
    consent?: (pageUrl: string) => ConsentChoice;
  }): Promise<EngineBrowser>;
}

const execute = promisify(execFile);

/**
 * `bind` also lists the browser in Playwright's per-user registry, where any local tool could find
 * and attach to it by name. The launcher attaches by socket path, so the listing is removed.
 */
export function forgetListing(title: string, home = os.homedir()) {
  const folder =
    process.platform === "darwin"
      ? path.join(home, "Library", "Caches", "ms-playwright", "b")
      : path.join(process.env.XDG_CACHE_HOME || path.join(home, ".cache"), "ms-playwright", "b");
  let names: string[] = [];
  try {
    names = readdirSync(folder);
  } catch {
    return;
  }
  for (const name of names)
    try {
      const file = path.join(folder, name);
      if (JSON.parse(readFileSync(file, "utf8")).title === title) rmSync(file, { force: true });
    } catch {
      // Not a listing, or already gone.
    }
}
// biome-ignore lint/suspicious/noExplicitAny: playwright-core is loaded at run time from the CLI's copy.
type Playwright = any;

/** Playwright from the pinned CLI's own dependency, with browsers from the daemon's folder. */
export function playwrightEngine(
  directory: string,
  options: { executablePath?: string } = {},
): BrowserEngine {
  let executable: Promise<string> | undefined;
  const require = createRequire(cliPath());
  const core = require.resolve("playwright-core");
  const executablePath = () => {
    if (options.executablePath) return Promise.resolve(options.executablePath);
    // Resolve in a child: Playwright caches browser paths at module initialization.
    executable ??= execute(
      process.execPath,
      ["-e", `console.log(require(${JSON.stringify(core)}).chromium.executablePath())`],
      {
        env: {
          ...process.env,
          PLAYWRIGHT_BROWSERS_PATH: path.join(directory, "browser", "browsers"),
        },
        timeout: 10000,
      },
    ).then((r) => r.stdout.trim());
    return executable;
  };
  return {
    async launch(options) {
      const { chromium } = require(core) as Playwright;
      const context = await chromium.launchPersistentContext(options.userDataDir, {
        headless: options.headless,
        executablePath: await executablePath(),
        chromiumSandbox: true,
        viewport: { width: 1024, height: 720 },
      });
      const pointerListeners: ((page: EnginePage, point: { x: number; y: number }) => void)[] = [];
      const wrapped = new Map<unknown, EnginePage>();
      const wrap = (page: Playwright): EnginePage => {
        const existing = wrapped.get(page);
        if (existing) return existing;
        const engine: EnginePage = {
          url: () => page.url(),
          async frames(onFrame, size) {
            const viewport = page.viewportSize() ?? { width: 1024, height: 720 };
            const width = Math.min(size.width, viewport.width);
            const height = Math.round((viewport.height * width) / viewport.width);
            const disposable = await page.screencast.start({
              quality: 60,
              size: { width, height },
              onFrame: (frame: { data: Buffer; viewportWidth: number; viewportHeight: number }) =>
                onFrame({
                  data: frame.data,
                  width: frame.viewportWidth,
                  height: frame.viewportHeight,
                }),
            });
            return async () => {
              await disposable?.[Symbol.asyncDispose]?.().catch(() => {});
              await page.screencast.stop().catch(() => {});
            };
          },
          async mouse(event) {
            if (event.type === "move") await page.mouse.move(event.x, event.y);
            else if (event.type === "wheel") {
              await page.mouse.move(event.x, event.y);
              await page.mouse.wheel(event.deltaX ?? 0, event.deltaY ?? 0);
            } else {
              await page.mouse.move(event.x, event.y);
              await page.mouse[event.type]({ button: event.button ?? "left" });
            }
          },
          async key(event) {
            if (event.type === "text") await page.keyboard.insertText(event.key);
            else await page.keyboard[event.type](event.key);
          },
          evaluate: (fn) => page.evaluate(fn),
          onClose: (listener) => page.on("close", listener),
          onLoad: (listener) => page.on("load", listener),
        };
        wrapped.set(page, engine);
        return engine;
      };
      await context.exposeBinding(
        "__zoltbotPointer",
        (source: { page: Playwright }, x: unknown, y: unknown) => {
          // Page scripts can call this too; take only plain coordinates.
          if (typeof x !== "number" || typeof y !== "number") return;
          if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 1e5 || y > 1e5)
            return;
          for (const listener of pointerListeners) listener(wrap(source.page), { x, y });
        },
      );
      await context.addInitScript(() => {
        addEventListener(
          "pointerdown",
          (event) =>
            (
              window as unknown as { __zoltbotPointer?: (x: number, y: number) => void }
            ).__zoltbotPointer?.(event.clientX, event.clientY),
          true,
        );
      });
      const { consent } = options;
      if (consent) {
        // Page scripts can call this too; it only says reject or accept for the page's own site.
        await context.exposeBinding("__zoltbotConsent", (source: { page: Playwright }) =>
          consent(String(source.page?.url?.() ?? "")),
        );
        await context.addInitScript(CONSENT_SCRIPT);
      }
      const { endpoint } = await context.browser().bind(options.title);
      forgetListing(options.title);
      return {
        endpoint,
        pages: () => context.pages().map(wrap),
        onPage: (listener) => context.on("page", (page: Playwright) => listener(wrap(page))),
        onPointer: (listener) => pointerListeners.push(listener),
        async close() {
          await context.close().catch(() => {});
          forgetListing(options.title);
        },
      };
    },
  };
}
