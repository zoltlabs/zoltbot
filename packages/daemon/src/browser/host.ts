// B2: one daemon-owned browser per browser task chat, watched from the Browser panel.
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BrowserEngine, EngineBrowser, EnginePage } from "./engine.js";
import type { BrowserBinding } from "./runtime.js";
import { type BrowserInput, controlFile, notesFile } from "./takeover-files.js";

/** One frame for the panel. Transient: never stored in the event log. */
export interface BrowserFrame {
  threadId: string;
  /** Base64 JPEG. */
  data: string;
  width: number;
  height: number;
  url: string;
  /** Where the last press landed, in page pixels. */
  pointer?: { x: number; y: number } | undefined;
}

/** Frames per second the panel can receive at most. */
export const MAX_FPS = 10;
/** Frames are at most this wide. */
export const MAX_FRAME_WIDTH = 1280;
/** A viewer that doesn't renew within this time is dropped (its window closed or crashed). */
export const VIEWER_TTL_MS = 20_000;

interface Running {
  binding: BrowserBinding;
  threadId: string;
  browser: EngineBrowser;
  profileId?: string;
  scratch?: string;
  page?: EnginePage | undefined;
  pointer?: { x: number; y: number } | undefined;
  stop?: Promise<() => Promise<void>> | undefined;
  lastFrame: number;
  generation: number;
  /** B3: the owner's takeover card while they control the browser. */
  control?: string | undefined;
}

interface Viewer {
  threadId: string;
  send: (frame: BrowserFrame) => void;
  expires: number;
}

export const endpointFile = (b: Pick<BrowserBinding, "home">) => path.join(b.home, "endpoint.json");

export class BrowserHost {
  private readonly running = new Map<string, Running>();
  private readonly viewers = new Map<string, Viewer>();
  private readonly starting = new Map<string, Promise<void>>();
  private readonly cancelled = new Set<string>();

  /** B3: called when a browser closes while the owner controls it, so its card can be withdrawn. */
  onControlLost: ((interactionId: string) => void) | undefined;

  /** Profiles being launched, so two chats of one agent can't both take its kept profile. */
  private readonly claimed = new Set<string>();

  constructor(
    private readonly engine: BrowserEngine,
    private readonly now: () => number = () => Date.now(),
    /** Isolated browsers' data, outside any project: cookies must never land in a workspace. */
    private readonly scratchRoot = path.join(os.tmpdir(), "zoltbot-browser-scratch"),
  ) {}

  /** The chat's browser, if one runs. */
  forThread(threadId: string) {
    return [...this.running.values()].find((r) => r.threadId === threadId);
  }

  /** Launches the binding's browser and tells its launcher where to attach. */
  ensure(binding: BrowserBinding, threadId: string): Promise<void> {
    if (this.running.has(binding.id)) return Promise.resolve();
    const pending = this.starting.get(binding.id);
    if (pending) return pending;
    const start = this.launch(binding, threadId).finally(() => {
      this.starting.delete(binding.id);
      if (binding.profile) this.claimed.delete(binding.profile.id);
    });
    this.starting.set(binding.id, start);
    return start;
  }

  private async launch(binding: BrowserBinding, threadId: string) {
    // A file left by an earlier daemon points at a dead browser; the launcher falls back without it.
    rmSync(endpointFile(binding), { force: true });
    // B3: a control file from before a restart would keep the agent waiting for no one.
    rmSync(controlFile(binding), { force: true });
    // B1: a kept profile can be open in one browser at a time; a second one runs isolated.
    const kept =
      binding.profile &&
      existsSync(path.join(binding.profile.dir, ".zoltbot-profile")) &&
      !this.claimed.has(binding.profile.id) &&
      ![...this.running.values()].some((r) => r.profileId === binding.profile?.id)
        ? binding.profile
        : undefined;
    if (kept) this.claimed.add(kept.id);
    const scratch = kept ? undefined : path.join(this.scratchRoot, binding.id);
    if (scratch) {
      // Never reuse what a crashed run left behind.
      rmSync(scratch, { recursive: true, force: true });
      mkdirSync(this.scratchRoot, { recursive: true, mode: 0o700 });
      mkdirSync(scratch, { mode: 0o700 });
    }
    let browser: EngineBrowser;
    try {
      browser = await this.engine.launch({
        userDataDir: kept?.dir ?? (scratch as string),
        headless: binding.mode === "background",
        title: binding.session,
      });
    } catch (error) {
      if (scratch) rmSync(scratch, { recursive: true, force: true });
      throw error;
    }
    // Closed while it launched: don't keep it.
    if (this.cancelled.delete(binding.id)) {
      await browser.close();
      if (scratch) rmSync(scratch, { recursive: true, force: true });
      return;
    }
    const run: Running = {
      binding,
      threadId,
      browser,
      ...(kept ? { profileId: kept.id } : {}),
      ...(scratch ? { scratch } : {}),
      lastFrame: 0,
      generation: 0,
    };
    this.running.set(binding.id, run);
    browser.onPage((page) => this.follow(run, page));
    browser.onPointer((page, point) => {
      if (page === run.page) run.pointer = point;
    });
    const first = browser.pages().at(-1);
    if (first) this.follow(run, first);
    mkdirSync(binding.home, { recursive: true, mode: 0o700 });
    const file = endpointFile(binding);
    const temp = `${file}.${process.pid}`;
    writeFileSync(temp, JSON.stringify({ endpoint: browser.endpoint }), { mode: 0o600 });
    renameSync(temp, file);
  }

  /** Watches the newest page; the panel follows it. */
  private follow(run: Running, page: EnginePage) {
    run.page = page;
    run.pointer = undefined;
    page.onClose(() => {
      if (run.page !== page) return;
      const next = run.browser
        .pages()
        .filter((p) => p !== page)
        .at(-1);
      if (next) this.follow(run, next);
      else {
        run.page = undefined;
        void this.restream(run);
      }
    });
    void this.restream(run);
  }

  private watched(threadId: string) {
    const now = this.now();
    for (const [id, viewer] of this.viewers) if (viewer.expires <= now) this.viewers.delete(id);
    return [...this.viewers.values()].filter((v) => v.threadId === threadId);
  }

  /** Starts or stops the screencast to match whether anyone is viewing. */
  private async restream(run: Running) {
    // Only the latest call starts a screencast, so two never overlap.
    const generation = ++run.generation;
    const previous = run.stop;
    run.stop = undefined;
    if (previous) await (await previous.catch(() => async () => {}))();
    if (generation !== run.generation) return;
    if (!run.page || !this.watched(run.threadId).length || !this.running.has(run.binding.id))
      return;
    const page = run.page;
    run.stop = page.frames((frame) => this.frame(run, page, frame), { width: MAX_FRAME_WIDTH });
    await run.stop.catch(() => {
      run.stop = undefined;
    });
  }

  private frame(
    run: Running,
    page: EnginePage,
    frame: { data: Buffer; width: number; height: number },
  ) {
    if (page !== run.page) return;
    const now = this.now();
    if (now - run.lastFrame < 1000 / MAX_FPS) return;
    const viewers = this.watched(run.threadId);
    if (!viewers.length) {
      void this.restream(run);
      return;
    }
    run.lastFrame = now;
    const body: BrowserFrame = {
      threadId: run.threadId,
      data: frame.data.toString("base64"),
      width: frame.width,
      height: frame.height,
      url: page.url(),
      ...(run.pointer ? { pointer: run.pointer } : {}),
    };
    for (const viewer of viewers)
      try {
        viewer.send(body);
      } catch {
        // A closed connection; its viewer expires.
      }
  }

  /** Opens, renews or closes one viewer of a chat's browser. */
  view(viewerId: string, threadId: string, open: boolean, send: (frame: BrowserFrame) => void) {
    const before = this.viewers.get(viewerId);
    if (open) this.viewers.set(viewerId, { threadId, send, expires: this.now() + VIEWER_TTL_MS });
    else this.viewers.delete(viewerId);
    for (const id of new Set([threadId, before?.threadId]))
      if (id) {
        const run = this.forThread(id);
        if (run && Boolean(run.stop) !== this.watched(id).length > 0) void this.restream(run);
      }
    const run = this.forThread(threadId);
    return {
      running: Boolean(run?.page),
      url: run?.page?.url() ?? null,
      control: Boolean(run?.control),
    };
  }

  /**
   * B3: gives the owner control (the launcher waits while the control file exists) or hands it
   * back, leaving the agent a note with where the page is now. Returns the page's address.
   */
  control(threadId: string, interactionId: string | undefined) {
    const run = this.forThread(threadId);
    if (!run) throw Error("browser_not_running");
    const url = run.page?.url() ?? "";
    const file = controlFile(run.binding);
    if (interactionId) {
      run.control = interactionId;
      writeFileSync(file, JSON.stringify({ since: this.now() }), { mode: 0o600 });
    } else if (run.control) {
      run.control = undefined;
      // The note goes first, so the next command the launcher runs already sees it.
      appendFileSync(
        notesFile(run.binding),
        `${JSON.stringify({ text: `The owner used the browser and handed it back at ${url || "a blank page"}.` })}\n`,
        { mode: 0o600 },
      );
      rmSync(file, { force: true });
    }
    return url;
  }

  /** The takeover card of the chat's browser, if the owner controls it. */
  controller(threadId: string) {
    return this.forThread(threadId)?.control;
  }

  /** B3: the owner's mouse or key, only while they control the browser. Never logged. */
  async input(threadId: string, event: BrowserInput) {
    const run = this.forThread(threadId);
    if (!run?.control || !run.page) throw Error("browser_not_in_control");
    // Engine errors can quote the key; they never leave here.
    try {
      if (event.kind === "mouse") {
        const { kind: _, ...mouse } = event;
        await run.page.mouse(mouse);
      } else await run.page.key({ type: event.type, key: event.key });
    } catch {
      throw Error("browser_input_failed");
    }
  }

  /** Whether a screencast runs for the chat (tests and diagnostics). */
  streaming(threadId: string) {
    return Boolean(this.forThread(threadId)?.stop);
  }

  async close(bindingId: string) {
    const starting = this.starting.get(bindingId);
    if (starting) {
      this.cancelled.add(bindingId);
      await starting.catch(() => {});
      this.cancelled.delete(bindingId);
    }
    const run = this.running.get(bindingId);
    if (!run) return;
    this.running.delete(bindingId);
    rmSync(endpointFile(run.binding), { force: true });
    rmSync(controlFile(run.binding), { force: true });
    if (run.control) this.onControlLost?.(run.control);
    const stop = run.stop;
    run.stop = undefined;
    if (stop) await (await stop.catch(() => async () => {}))();
    await run.browser.close();
    if (run.scratch) rmSync(run.scratch, { recursive: true, force: true });
  }

  /** B1: Clear closes any browser using the profile before its folder goes. */
  async closeProfile(profileId: string) {
    await Promise.all([...this.starting.values()].map((p) => p.catch(() => {})));
    for (const run of [...this.running.values()])
      if (run.profileId === profileId) await this.close(run.binding.id);
  }

  /** Closes browsers whose chat no longer runs. */
  async sweep(isLive: (threadId: string) => boolean) {
    for (const run of [...this.running.values()])
      if (!isLive(run.threadId)) await this.close(run.binding.id);
  }

  async closeAll() {
    for (const id of [...this.starting.keys(), ...this.running.keys()]) await this.close(id);
  }
}

const hosts = new Map<string, BrowserHost>();
/** The daemon's one host for its data folder, shared by the runtime and the API. */
export function browserHostFor(dataDir: string, engine?: () => BrowserEngine) {
  let host = hosts.get(dataDir);
  if (!host && engine) {
    host = new BrowserHost(engine(), undefined, path.join(dataDir, "browser", "scratch"));
    hosts.set(dataDir, host);
  }
  return host;
}
export function forgetBrowserHost(dataDir: string) {
  const host = hosts.get(dataDir);
  hosts.delete(dataDir);
  return host?.closeAll();
}
