import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { DETECT_SCRIPT, type PageNeeds } from "./detect.js";
import type { BrowserEngine, EngineFrame, EnginePage } from "./engine.js";
import { playwrightEngine } from "./engine.js";
import {
  type BrowserFrame,
  BrowserHost,
  endpointFile,
  MAX_FPS,
  MAX_FRAME_WIDTH,
  PHONE_VIEWER,
  VIEWER_TTL_MS,
} from "./host.js";
import { browserBinding, materializeBrowser } from "./runtime.js";

class FakePage implements EnginePage {
  starts = 0;
  stops = 0;
  widths: number[] = [];
  emit: ((frame: EngineFrame) => void) | undefined;
  private closers: (() => void)[] = [];
  constructor(private readonly address = "https://example.test/") {}
  url() {
    return this.address;
  }
  async frames(onFrame: (frame: EngineFrame) => void, size: { width: number }) {
    this.starts++;
    this.widths.push(size.width);
    this.emit = onFrame;
    return async () => {
      this.stops++;
      this.emit = undefined;
    };
  }
  async mouse() {}
  async key() {}
  async evaluate<T>() {
    return undefined as T;
  }
  onClose(listener: () => void) {
    this.closers.push(listener);
  }
  onLoad() {}
  close() {
    for (const listener of this.closers) listener();
  }
}

function fakeEngine() {
  const launches: { userDataDir: string; closed: boolean; page: FakePage }[] = [];
  const engine: BrowserEngine = {
    async launch(options) {
      const page = new FakePage();
      const entry = { userDataDir: options.userDataDir, closed: false, page };
      launches.push(entry);
      return {
        endpoint: `/tmp/fake-${launches.length}.sock`,
        pages: () => [page],
        onPage() {},
        onPointer() {},
        async close() {
          entry.closed = true;
        },
      };
    },
  };
  return { engine, launches };
}

const frame = { data: Buffer.from("jpeg"), width: 1280, height: 800 };
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

function binding(root: string, profile?: { id: string; dir: string }) {
  mkdirSync(path.join(root, "work"), { recursive: true });
  return browserBinding(root, path.join(root, "work"), { mode: "background" }, profile, true);
}

describe("browser host", () => {
  it("streams frames only while someone views, and stops when they leave", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "zb-host-"));
    try {
      const { engine, launches } = fakeEngine();
      let clock = 1_000;
      const scratchRoot = path.join(root, "scratch");
      const host = new BrowserHost(engine, () => clock, scratchRoot);
      const b = binding(root);
      await host.ensure(b, "thread");
      expect(JSON.parse(readFileSync(endpointFile(b), "utf8"))).toEqual({
        endpoint: "/tmp/fake-1.sock",
      });
      const page = launches[0]?.page as FakePage;
      await settle();
      expect(page.starts).toBe(0);

      const seen: BrowserFrame[] = [];
      expect(host.view("viewer", "thread", true, (f) => seen.push(f))).toEqual({
        running: true,
        url: "https://example.test/",
        control: false,
        asked: false,
        cookies: null,
        teach: null,
      });
      await settle();
      expect(page.starts).toBe(1);
      expect(host.streaming("thread")).toBe(true);
      page.emit?.(frame);
      expect(seen).toEqual([
        {
          threadId: "thread",
          data: "anBlZw==",
          width: 1280,
          height: 800,
          url: "https://example.test/",
        },
      ]);

      host.view("viewer", "thread", false, () => {});
      await settle();
      expect(page.stops).toBe(1);
      expect(host.streaming("thread")).toBe(false);

      // A viewer that stops renewing is dropped at the next frame.
      host.view("viewer", "thread", true, (f) => seen.push(f));
      await settle();
      clock += VIEWER_TTL_MS + 1;
      page.emit?.(frame);
      await settle();
      expect(host.streaming("thread")).toBe(false);
      expect(page.stops).toBe(2);

      await host.close(b.id);
      expect(existsSync(endpointFile(b))).toBe(false);
      expect(launches[0]?.closed).toBe(true);
      // The isolated browser's data stays outside the workspace and goes when it closes.
      expect(launches[0]?.userDataDir).toBe(path.join(scratchRoot, b.id));
      expect(existsSync(path.join(scratchRoot, b.id))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it(`caps frames at ${MAX_FPS} a second`, async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "zb-host-"));
    try {
      const { engine, launches } = fakeEngine();
      let clock = 1_000;
      const host = new BrowserHost(engine, () => clock);
      await host.ensure(binding(root), "thread");
      let count = 0;
      host.view("viewer", "thread", true, () => count++);
      await settle();
      // 60 frames over one second, as a busy page would send.
      for (let i = 0; i < 60; i++) {
        launches[0]?.page.emit?.(frame);
        clock += 1000 / 60;
      }
      expect(count).toBeLessThanOrEqual(MAX_FPS + 1);
      expect(count).toBeGreaterThanOrEqual(MAX_FPS - 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("gives a phone narrower frames at its own pace and budget", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "zb-host-"));
    try {
      const { engine, launches } = fakeEngine();
      let clock = 1_000;
      const host = new BrowserHost(engine, () => clock);
      await host.ensure(binding(root), "thread");
      const page = launches[0]?.page as FakePage;
      let phone = 0;
      host.view("phone", "thread", true, () => phone++, PHONE_VIEWER);
      await settle();
      // A phone alone gets the narrow screencast.
      expect(page.widths).toEqual([PHONE_VIEWER.maxWidth]);
      for (let i = 0; i < 60; i++) {
        page.emit?.(frame);
        clock += 1000 / 60;
      }
      expect(phone).toBeGreaterThanOrEqual(2);
      expect(phone).toBeLessThanOrEqual(Math.ceil(1000 / PHONE_VIEWER.minIntervalMs));

      // The Mac's panel opening widens the screencast; closing it narrows it again.
      let mac = 0;
      host.view("mac", "thread", true, () => mac++);
      await settle();
      expect(page.widths.at(-1)).toBe(MAX_FRAME_WIDTH);
      for (let i = 0; i < 60; i++) {
        page.emit?.(frame);
        clock += 1000 / 60;
      }
      expect(mac).toBeGreaterThan(phone);
      host.view("mac", "thread", false, () => {});
      await settle();
      expect(page.widths.at(-1)).toBe(PHONE_VIEWER.maxWidth);

      // Past its byte budget the phone gets nothing more until the minute turns.
      const big = { ...frame, data: Buffer.alloc(150 * 1024) };
      const budget = PHONE_VIEWER.bytesPerMinute ?? 0;
      let bytes = 0;
      clock += 60_000;
      host.view("phone", "thread", true, (f) => (bytes += f.data.length), PHONE_VIEWER);
      await settle();
      for (let i = 0; i < 200; i++) {
        page.emit?.(big);
        clock += 250;
      }
      expect(bytes).toBeGreaterThan(0);
      expect(bytes).toBeLessThanOrEqual(budget);
      const capped = bytes;
      clock += 60_000;
      host.view("phone", "thread", true, (f) => (bytes += f.data.length), PHONE_VIEWER);
      page.emit?.(big);
      expect(bytes).toBeGreaterThan(capped);
      // A frame too large for one relay message is skipped.
      const before = bytes;
      clock += 1000;
      page.emit?.({ ...frame, data: Buffer.alloc(300 * 1024) });
      expect(bytes).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses a kept profile once at a time and runs a second browser isolated", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "zb-host-"));
    try {
      const { engine, launches } = fakeEngine();
      const scratchRoot = path.join(root, "scratch");
      const host = new BrowserHost(engine, undefined, scratchRoot);
      const dir = path.join(root, "browser-profiles", "aaaaaaaa-1");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, ".zoltbot-profile"), "");
      const first = binding(root, { id: "aaaaaaaa-1", dir });
      const second = binding(root, { id: "aaaaaaaa-1", dir });
      // Started together, only one gets the profile.
      await Promise.all([host.ensure(first, "one"), host.ensure(second, "two")]);
      expect(launches.map((l) => l.userDataDir)).toEqual([dir, path.join(scratchRoot, second.id)]);
      // Clear closes the browser holding the profile first.
      await host.closeProfile("aaaaaaaa-1");
      expect(launches[0]?.closed).toBe(true);
      expect(launches[1]?.closed).toBe(false);
      await host.sweep((threadId) => threadId !== "two");
      expect(launches[1]?.closed).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("drops a stale endpoint and closes a browser closed while it launched", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "zb-host-"));
    try {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { engine, launches } = fakeEngine();
      const slow: BrowserEngine = {
        async launch(options) {
          await gate;
          return engine.launch(options);
        },
      };
      const host = new BrowserHost(slow, undefined, path.join(root, "scratch"));
      const b = binding(root);
      mkdirSync(b.home, { recursive: true });
      writeFileSync(endpointFile(b), JSON.stringify({ endpoint: "/tmp/dead.sock" }));
      const started = host.ensure(b, "thread");
      expect(existsSync(endpointFile(b))).toBe(false);
      const closed = host.close(b.id);
      release();
      await Promise.all([started, closed]);
      expect(launches[0]?.closed).toBe(true);
      expect(host.forThread("thread")).toBeUndefined();
      expect(existsSync(endpointFile(b))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// A real Chromium, when this machine has one Playwright installed earlier.
const cache = path.join(os.homedir(), "Library", "Caches", "ms-playwright");
const shell = existsSync(cache)
  ? readdirSync(cache)
      .filter((name) => name.startsWith("chromium_headless_shell-"))
      .map((name) =>
        path.join(cache, name, "chrome-headless-shell-mac-arm64", "chrome-headless-shell"),
      )
      .find((file) => existsSync(file))
  : undefined;

describe.skipIf(!shell)("hosted launcher with a real browser", () => {
  it("attaches the agent's CLI to the daemon's browser and streams what it opens", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "zb-hosted-"));
    const host = new BrowserHost(
      playwrightEngine(root, { executablePath: shell as string }),
      undefined,
      path.join(root, "scratch"),
    );
    try {
      const b = binding(root);
      materializeBrowser(b);
      await host.ensure(b, "thread");
      const frames: BrowserFrame[] = [];
      host.view("viewer", "thread", true, (f) => frames.push(f));
      const run = promisify(execFile);
      const page = "data:text/html,<h1>Hosted</h1>";
      const opened = await run(b.launcher, ["open", page], { cwd: b.cwd, timeout: 60_000 });
      expect(opened.stdout).toContain("Hosted");
      const snapshot = await run(b.launcher, ["snapshot"], { cwd: b.cwd, timeout: 60_000 });
      expect(snapshot.stdout).toContain('heading "Hosted"');
      await expect.poll(() => frames.at(-1)?.url, { timeout: 10_000 }).toBe(page);
      expect(Buffer.from(frames.at(-1)?.data ?? "", "base64").subarray(0, 2)).toEqual(
        Buffer.from([0xff, 0xd8]),
      );
      // B3: while the owner has the browser, the agent's command waits, then hears what changed.
      host.control("thread", "card");
      let done = false;
      const waiting = run(b.launcher, ["snapshot"], { cwd: b.cwd, timeout: 60_000 }).finally(() => {
        done = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(done).toBe(false);
      host.control("thread", undefined);
      expect((await waiting).stdout).toContain(
        `The owner used the browser and handed it back at ${page}.`,
      );
      const next = await run(b.launcher, ["snapshot"], { cwd: b.cwd, timeout: 60_000 });
      expect(next.stdout).not.toContain("handed it back");
      await run(b.launcher, ["close"], { cwd: b.cwd, timeout: 60_000 });
      await host.closeAll();
      // No local tool can find the browser by name.
      const listings = path.join(cache, "b");
      const named = existsSync(listings)
        ? readdirSync(listings).filter((name) =>
            readFileSync(path.join(listings, name), "utf8").includes(b.session),
          )
        : [];
      expect(named).toEqual([]);
    } finally {
      await host.closeAll();
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it("spots sign-in, human checks and payment fields, and ignores hidden ones", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "zb-detect-"));
    const browser = await playwrightEngine(root, { executablePath: shell as string }).launch({
      userDataDir: path.join(root, "data"),
      headless: true,
      title: `zb-detect-${Date.now()}`,
    });
    try {
      const page = browser.pages()[0] as EnginePage;
      const check = (html: string) =>
        page.evaluate<PageNeeds>(
          `(() => { document.body.innerHTML = ${JSON.stringify(html)}; return ${DETECT_SCRIPT}; })()`,
        );
      const none = { password: false, verification: false, payment: false };
      expect(await check("<h1>Orders</h1><input name=q>")).toEqual(none);
      expect(await check("<form><input name=user><input type=password></form>")).toEqual({
        ...none,
        password: true,
      });
      expect(await check("<input type=password style='display:none'>")).toEqual(none);
      expect(
        await check(
          "<iframe src='https://www.google.com/recaptcha/api2/anchor' width=300 height=80></iframe>",
        ),
      ).toEqual({ ...none, verification: true });
      expect(
        await check("<div class='cf-turnstile' style='width:300px;height:65px'></div>"),
      ).toEqual({
        ...none,
        verification: true,
      });
      expect(await check("<input autocomplete='cc-number'><input autocomplete='cc-exp'>")).toEqual({
        ...none,
        payment: true,
      });
    } finally {
      await browser.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("lets the agent ask the owner, and tells it once when a page wants a password", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "zb-help-"));
    const host = new BrowserHost(
      playwrightEngine(root, { executablePath: shell as string }),
      undefined,
      path.join(root, "scratch"),
    );
    const asked: unknown[] = [];
    host.onHelp = (threadId, request) => {
      asked.push(request);
      host.control(threadId, "card");
    };
    const run = promisify(execFile);
    try {
      const b = binding(root);
      materializeBrowser(b);
      await host.ensure(b, "thread");
      const opened = await run(
        b.launcher,
        ["open", "data:text/html,<form><input type=password></form>"],
        { cwd: b.cwd, timeout: 60_000 },
      );
      let seen = opened.stdout;
      for (let i = 0; i < 5 && !seen.includes("asks for a password"); i++)
        seen += (await run(b.launcher, ["snapshot"], { cwd: b.cwd, timeout: 60_000 })).stdout;
      expect(seen).toContain("This page asks for a password.");
      // Once per site: a reload doesn't repeat it.
      await run(b.launcher, ["reload"], { cwd: b.cwd, timeout: 60_000 });
      const again = await run(b.launcher, ["snapshot"], { cwd: b.cwd, timeout: 60_000 });
      expect(again.stdout).not.toContain("asks for a password");

      const help = await run(
        b.launcher,
        ["need-human", "sign_in", "Log", "in", "to", "the", "shop"],
        {
          cwd: b.cwd,
          timeout: 60_000,
        },
      );
      expect(help.stdout).toContain("Asked the owner.");
      expect(asked).toEqual([{ reason: "sign_in", note: "Log in to the shop" }]);
      expect(existsSync(path.join(b.home, "control.json"))).toBe(true);
      host.control("thread", undefined);
      await expect(
        run(b.launcher, ["need-human", "captcha"], { cwd: b.cwd, timeout: 60_000 }),
      ).rejects.toMatchObject({ code: 2 });
    } finally {
      await host.closeAll();
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
