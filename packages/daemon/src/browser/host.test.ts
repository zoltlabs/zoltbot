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
import type { BrowserEngine, EngineFrame, EnginePage } from "./engine.js";
import { playwrightEngine } from "./engine.js";
import { type BrowserFrame, BrowserHost, endpointFile, MAX_FPS, VIEWER_TTL_MS } from "./host.js";
import { browserBinding, materializeBrowser } from "./runtime.js";

class FakePage implements EnginePage {
  starts = 0;
  stops = 0;
  emit: ((frame: EngineFrame) => void) | undefined;
  private closers: (() => void)[] = [];
  constructor(private readonly address = "https://example.test/") {}
  url() {
    return this.address;
  }
  async frames(onFrame: (frame: EngineFrame) => void) {
    this.starts++;
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
});
