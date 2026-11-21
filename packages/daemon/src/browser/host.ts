// B2: one daemon-owned browser per browser task chat, watched from the Browser panel.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { phoneScreen } from "@zoltbot/link";
import { consentChoice, siteOf } from "./consent.js";
import { DETECT_SCRIPT, NUDGES, type PageNeeds } from "./detect.js";
import type { BrowserEngine, EngineBrowser, EnginePage } from "./engine.js";
import type { PurchaseDetails } from "./purchase.js";
import type { BrowserBinding } from "./runtime.js";
import { SITE_NOTES_TIP } from "./site-notes.js";
import {
  type BrowserInput,
  controlFile,
  type HelpRequest,
  helpFile,
  notesFile,
  owning,
  parseHelp,
} from "./takeover-files.js";
import { Recording, TEACH_INPUT_WINDOW_MS } from "./teach.js";

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

/** What one viewer takes: frame width, rate and, for viewers over the relay, a byte budget. */
export interface ViewerLimits {
  maxWidth: number;
  minIntervalMs: number;
  /** A frame larger than this many base64 bytes is skipped. */
  maxFrameBytes?: number;
  /** Frames past this many base64 bytes in a minute are skipped until the minute turns. */
  bytesPerMinute?: number;
}
const DESKTOP_VIEWER: ViewerLimits = { maxWidth: MAX_FRAME_WIDTH, minIntervalMs: 0 };
/** P8: a paired phone over the relay: a narrower picture, a few times a second. */
export const PHONE_VIEWER: ViewerLimits = phoneScreen;

interface Running {
  binding: BrowserBinding;
  threadId: string;
  browser: EngineBrowser;
  profileId?: string;
  scratch?: string;
  page?: EnginePage | undefined;
  pointer?: { x: number; y: number } | undefined;
  stop?: Promise<() => Promise<void>> | undefined;
  /** The screencast's width: the widest any viewer takes. */
  width?: number | undefined;
  lastFrame: number;
  generation: number;
  /** B3: the owner's takeover card while they control the browser. */
  control?: string | undefined;
  /** B4: nudges already given, by kind and site. */
  nudged: Set<string>;
  /** B5: the site whose cookie banner was answered last, for the panel. */
  cookies?: { site: string } | undefined;
  consentWindow: { since: number; count: number };
  /** B7: hosts looked up and sites whose notes the agent has this run, and whether it heard the tip. */
  noted: Set<string>;
  tipped?: boolean;
  /** M7: what the owner is teaching, while they teach. */
  teach?: Recording | undefined;
  /** M7: when the owner last sent a mouse or key, so page scripts can't pass off steps. */
  ownerInput?: number;
  /** B6: the held pay click waiting for the owner. */
  purchase?: ((approve: boolean) => Promise<boolean>) | undefined;
}

interface Viewer {
  threadId: string;
  send: (frame: BrowserFrame) => void;
  expires: number;
  limits: ViewerLimits;
  last: number;
  budget: { since: number; used: number };
}

export const endpointFile = (b: Pick<BrowserBinding, "home">) => path.join(b.home, "endpoint.json");

export class BrowserHost {
  private readonly running = new Map<string, Running>();
  private readonly viewers = new Map<string, Viewer>();
  private readonly starting = new Map<string, Promise<void>>();
  private readonly cancelled = new Set<string>();

  /** B3: called when a browser closes while the owner controls it, so its card can be withdrawn. */
  onControlLost: ((interactionId: string) => void) | undefined;

  /** B4: the agent asked for the owner; the listener raises a card and calls control(). */
  onHelp: ((threadId: string, request: HelpRequest, url: string) => void) | undefined;

  /** B6: a pay click was held; the listener raises a card and calls control(). */
  onPurchase: ((threadId: string, details: PurchaseDetails, url: string) => void) | undefined;
  /** B7: the team's notes about the site a page is on, if any. */
  siteNotes:
    | ((threadId: string, url: string) => { site: string; text: string } | undefined)
    | undefined;
  /** B6: sites where the owner lets the agent pay without asking. */
  purchaseSites: () => readonly string[] = () => [];

  /** B5: sites where cookie banners are accepted; everywhere else they're rejected. */
  cookieSites: () => readonly string[] = () => [];
  private helpTimer: ReturnType<typeof setInterval> | undefined;

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
    rmSync(helpFile(binding), { force: true });
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
    const banners: { run?: Running } = {};
    try {
      browser = await this.engine.launch({
        userDataDir: kept?.dir ?? (scratch as string),
        headless: binding.mode === "background",
        title: binding.session,
        consent: (url) => {
          const run = banners.run;
          // The owner answers banners themselves while they have the browser. Page scripts can
          // call this too, so a busy page gets no more than 60 answers a minute.
          if (!run || owning(run.control)) return "skip";
          const now = this.now();
          if (now - run.consentWindow.since > 60_000) run.consentWindow = { since: now, count: 0 };
          if (++run.consentWindow.count > 60) return "skip";
          run.cookies = { site: siteOf(url) };
          return consentChoice(url, this.cookieSites());
        },
        purchase: (url, details, answer) => this.held(banners.run, url, details, answer),
        teach: (step) => {
          const run = banners.run;
          if (run?.teach && this.now() - (run.ownerInput ?? -Infinity) <= TEACH_INPUT_WINDOW_MS)
            run.teach.record(step);
        },
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
      nudged: new Set(),
      consentWindow: { since: 0, count: 0 },
      noted: new Set(),
    };
    banners.run = run;
    this.running.set(binding.id, run);
    browser.onPage((page) => this.follow(run, page));
    browser.onPointer((page, point) => {
      if (page === run.page) run.pointer = point;
    });
    this.helpTimer ??= setInterval(() => this.checkHelp(), 500);
    this.helpTimer.unref?.();
    const first = browser.pages().at(-1);
    if (first) this.follow(run, first);
    mkdirSync(binding.home, { recursive: true, mode: 0o700 });
    const file = endpointFile(binding);
    const temp = `${file}.${process.pid}`;
    writeFileSync(temp, JSON.stringify({ endpoint: browser.endpoint }), { mode: 0o600 });
    renameSync(temp, file);
  }

  /** B6: the owner's own clicks and listed sites go through; anything else waits for a card. */
  private held(
    run: Running | undefined,
    url: string,
    details: PurchaseDetails,
    answer: (approve: boolean) => Promise<boolean>,
  ) {
    if (!run) return void answer(false);
    if (owning(run.control) || consentChoice(url, this.purchaseSites()) === "accept")
      return void answer(true);
    // One question at a time; the agent is already waiting on the open card.
    if (run.purchase || run.control) return void answer(false);
    run.purchase = answer;
    try {
      if (!this.onPurchase) throw Error("no_listener");
      this.onPurchase(run.threadId, details, url);
    } catch {
      run.purchase = undefined;
      void answer(false);
      this.note(
        run,
        "The owner couldn’t be asked to confirm the purchase, so nothing was clicked.",
      );
    }
  }

  /** B6: the owner's answer. Approval clicks the held button once; the agent hears either way. */
  async settlePurchase(threadId: string, approve: boolean) {
    const run = this.forThread(threadId);
    const answer = run?.purchase;
    if (!run || !answer) return false;
    run.purchase = undefined;
    const card = run.control;
    const clicked = approve && (await answer(true));
    if (!approve) await answer(false);
    // The owner may have taken over meanwhile; their card stays.
    if (run.control !== card) return clicked;
    this.control(
      threadId,
      undefined,
      !approve
        ? "The owner declined the purchase."
        : clicked
          ? "The owner confirmed the purchase, and the button was clicked once."
          : "The owner confirmed the purchase, but the page had changed, so nothing was clicked.",
    );
    return clicked;
  }

  /** B6: forgets a held click without clicking it. */
  dropPurchase(threadId: string) {
    const run = this.forThread(threadId);
    const answer = run?.purchase;
    if (!run || !answer) return false;
    run.purchase = undefined;
    void answer(false);
    return true;
  }

  /** B4: picks up `need-human` requests the agent's launcher left. */
  checkHelp() {
    for (const run of this.running.values()) {
      const file = helpFile(run.binding);
      if (!existsSync(file)) continue;
      let request: HelpRequest | undefined;
      try {
        request = parseHelp(JSON.parse(readFileSync(file, "utf8")));
      } catch {}
      rmSync(file, { force: true });
      if (!request || run.control || !this.onHelp) continue;
      try {
        this.onHelp(run.threadId, request, run.page?.url() ?? "");
      } catch {
        // No card, no control file: the launcher tells the agent it couldn't ask.
      }
    }
  }

  /** B4: tells the agent once per site when a page wants a password, a check or payment. */
  private async detect(run: Running, page: EnginePage) {
    if (run.control || page !== run.page) return;
    let needs: PageNeeds | undefined;
    try {
      // A page can stall its own scripts; don't wait on it.
      needs = await Promise.race([
        page.evaluate<PageNeeds>(DETECT_SCRIPT),
        new Promise<undefined>((resolve) => {
          const timer = setTimeout(resolve, 2000) as { unref?: () => void };
          timer.unref?.();
        }),
      ]);
    } catch {
      return;
    }
    let site = "";
    try {
      site = new URL(page.url()).host;
    } catch {}
    for (const kind of ["password", "verification", "payment"] as const) {
      if (!needs?.[kind] || run.nudged.has(`${kind}:${site}`) || run.nudged.size >= 12) continue;
      run.nudged.add(`${kind}:${site}`);
      this.note(run, NUDGES[kind]);
    }
  }

  /** B7: on a site with notes, the agent gets them with its next command, once a run. */
  private landed(run: Running, page: EnginePage) {
    if (page !== run.page) return;
    const url = page.url();
    run.teach?.navigate(url);
    if (!/^https?:/i.test(url) || owning(run.control) || run.noted.size >= 50) return;
    let host = "";
    try {
      host = new URL(url).hostname;
    } catch {
      return;
    }
    // Each host is looked up once a run; the lookup is skipped for hosts already seen.
    if (run.noted.has(host)) return;
    run.noted.add(host);
    let found: { site: string; text: string } | undefined;
    try {
      found = this.siteNotes?.(run.threadId, url);
    } catch {
      return;
    }
    if (!found || run.noted.has(`site:${found.site}`)) return;
    run.noted.add(`site:${found.site}`);
    // One note, so control notes (declines, takeovers) aren't pushed out of the launcher's last 3.
    const tip = run.tipped ? "" : `\n${SITE_NOTES_TIP}`;
    run.tipped = true;
    this.note(run, `${found.text}${tip}`);
  }

  private note(run: Running, text: string) {
    mkdirSync(run.binding.home, { recursive: true, mode: 0o700 });
    appendFileSync(notesFile(run.binding), `${JSON.stringify({ text })}\n`, { mode: 0o600 });
  }

  /** Watches the newest page; the panel follows it. */
  private follow(run: Running, page: EnginePage) {
    run.page = page;
    run.pointer = undefined;
    page.onLoad(() => {
      void this.detect(run, page);
      this.landed(run, page);
    });
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
    run.width = this.widthFor(run.threadId);
    run.stop = page.frames((frame) => this.frame(run, page, frame), { width: run.width });
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
    run.teach?.frame(frame.data);
    const now = this.now();
    if (now - run.lastFrame < 1000 / MAX_FPS) return;
    const viewers = this.watched(run.threadId);
    if (!viewers.length) {
      void this.restream(run);
      return;
    }
    run.lastFrame = now;
    let body: BrowserFrame | undefined;
    for (const viewer of viewers) {
      const { limits, budget } = viewer;
      if (now - viewer.last < limits.minIntervalMs) continue;
      body ??= {
        threadId: run.threadId,
        data: frame.data.toString("base64"),
        width: frame.width,
        height: frame.height,
        url: page.url(),
        ...(run.pointer ? { pointer: run.pointer } : {}),
      };
      if (limits.maxFrameBytes !== undefined && body.data.length > limits.maxFrameBytes) continue;
      if (limits.bytesPerMinute !== undefined) {
        if (now - budget.since >= 60_000) {
          budget.since = now;
          budget.used = 0;
        }
        if (budget.used + body.data.length > limits.bytesPerMinute) continue;
        budget.used += body.data.length;
      }
      viewer.last = now;
      try {
        viewer.send(body);
      } catch {
        // A closed connection; its viewer expires.
      }
    }
  }

  /** The widest picture anyone watching the chat takes. */
  private widthFor(threadId: string) {
    return Math.max(0, ...this.watched(threadId).map((v) => v.limits.maxWidth)) || MAX_FRAME_WIDTH;
  }

  /** Opens, renews or closes one viewer of a chat's browser. */
  view(
    viewerId: string,
    threadId: string,
    open: boolean,
    send: (frame: BrowserFrame) => void,
    limits: ViewerLimits = DESKTOP_VIEWER,
  ) {
    const before = this.viewers.get(viewerId);
    // A renewal keeps the viewer's pace and budget.
    const kept = before?.threadId === threadId ? before : undefined;
    if (open)
      this.viewers.set(viewerId, {
        threadId,
        send,
        expires: this.now() + VIEWER_TTL_MS,
        limits,
        last: kept?.last ?? 0,
        budget: kept?.budget ?? { since: this.now(), used: 0 },
      });
    else this.viewers.delete(viewerId);
    for (const id of new Set([threadId, before?.threadId]))
      if (id) {
        const run = this.forThread(id);
        const watching = this.watched(id).length > 0;
        if (
          run &&
          (Boolean(run.stop) !== watching ||
            (watching && run.stop && run.width !== this.widthFor(id)))
        )
          void this.restream(run);
      }
    const run = this.forThread(threadId);
    return {
      running: Boolean(run?.page),
      url: run?.page?.url() ?? null,
      control: owning(run?.control),
      asked: Boolean(run?.control) && !owning(run?.control),
      // B5: the banner answered on the page shown, if any.
      cookies:
        run?.cookies && run.page && siteOf(run.page.url()) === run.cookies.site
          ? {
              site: run.cookies.site,
              accept: consentChoice(run.page.url(), this.cookieSites()) === "accept",
            }
          : null,
      teach: run?.teach ? { steps: run.teach.steps.length } : null,
    };
  }

  /** M7: starts recording what the owner does, from the page shown now. */
  teachStart(threadId: string) {
    const run = this.forThread(threadId);
    if (!run?.page) throw Error("browser_not_running");
    if (!run.teach) {
      run.teach = new Recording(path.join(run.binding.artifactRoot, "teach"));
      run.teach.navigate(run.page.url());
    }
    return run.teach.steps.length;
  }

  /** M7: writes the recording out for the agent (once) and returns it; it stays until cleared. */
  teachFinish(threadId: string) {
    const recording = this.forThread(threadId)?.teach;
    if (!recording?.steps.length) return undefined;
    return { file: recording.finish(), steps: recording.steps.length };
  }

  /** M7: ends teaching; `discard` deletes what was recorded. */
  teachClear(threadId: string, discard: boolean) {
    const run = this.forThread(threadId);
    if (!run?.teach) return;
    if (discard) run.teach.discard();
    run.teach = undefined;
  }

  /**
   * B3: gives the owner control (the launcher waits while the control file exists) or hands it
   * back, leaving the agent a note with where the page is now. Returns the page's address.
   */
  control(threadId: string, interactionId: string | undefined, note?: string) {
    const run = this.forThread(threadId);
    if (!run) throw Error("browser_not_running");
    const url = run.page?.url() ?? "";
    const file = controlFile(run.binding);
    if (interactionId) {
      run.control = interactionId;
      writeFileSync(file, JSON.stringify({ since: this.now() }), { mode: 0o600 });
    } else if (run.control) {
      run.control = undefined;
      // Control ended some other way (the phone, Needs you): nothing unsent is kept.
      if (run.teach && !run.teach.finished) run.teach.discard();
      run.teach = undefined;
      // The note goes first, so the next command the launcher runs already sees it.
      this.note(
        run,
        note ?? `The owner used the browser and handed it back at ${url || "a blank page"}.`,
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
    if (!owning(run?.control) || !run?.page) throw Error("browser_not_in_control");
    run.ownerInput = this.now();
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
    if (run.teach && !run.teach.finished) run.teach.discard();
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
    clearInterval(this.helpTimer);
    this.helpTimer = undefined;
    for (const id of [...this.starting.keys(), ...this.running.keys()]) await this.close(id);
  }
}

const hosts = new Map<string, BrowserHost>();
const setups = new Map<string, (host: BrowserHost) => void>();
/** Runs `setup` on the data folder's host now, or when the runtime creates it. */
export function onBrowserHost(dataDir: string, setup: (host: BrowserHost) => void) {
  setups.set(dataDir, setup);
  const host = hosts.get(dataDir);
  if (host) setup(host);
}
/** The daemon's one host for its data folder, shared by the runtime and the API. */
export function browserHostFor(dataDir: string, engine?: () => BrowserEngine) {
  let host = hosts.get(dataDir);
  if (!host && engine) {
    host = new BrowserHost(engine(), undefined, path.join(dataDir, "browser", "scratch"));
    hosts.set(dataDir, host);
    setups.get(dataDir)?.(host);
  }
  return host;
}
export function forgetBrowserHost(dataDir: string) {
  const host = hosts.get(dataDir);
  hosts.delete(dataDir);
  return host?.closeAll();
}
