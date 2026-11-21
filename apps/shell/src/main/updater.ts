// D3: app updates. Checks at launch and every 6 hours, downloads in the background and restarts
// into the new version when the owner asks. Agents keep running: the daemon is its own process.
// Only a signed, notarized build has an update feed (app-update.yml); other builds stay
// "unsupported" and show nothing.
import type { UpdateStatus } from "../shared/ipc";

export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const MAX_NOTES = 4000;

/** The part of electron-updater's autoUpdater this uses, so tests can pass a fake feed. */
export interface UpdateFeed {
  checkForUpdates(): Promise<{
    updateInfo: { version: string; releaseNotes?: unknown };
  } | null>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(): void;
  onProgress(listener: (percent: number) => void): void;
}

/** Whether `next` is a later version than `current` (major.minor.patch; pre-releases sort first). */
export function newerVersion(next: string, current: string): boolean {
  const parse = (value: string) => {
    const [core = "", pre] = value.replace(/^v/, "").split("-", 2);
    return { parts: core.split(".").map((part) => Number.parseInt(part, 10) || 0), pre };
  };
  const a = parse(next);
  const b = parse(current);
  for (let index = 0; index < 3; index++) {
    const difference = (a.parts[index] ?? 0) - (b.parts[index] ?? 0);
    if (difference) return difference > 0;
  }
  if (a.pre === b.pre) return false;
  if (!a.pre) return true;
  if (!b.pre) return false;
  return a.pre > b.pre;
}

/** A GitHub release body as plain text: tags removed, common entities decoded, kept short. */
export function releaseNotesText(notes: unknown): string | null {
  const raw = Array.isArray(notes)
    ? notes.map((note) => String((note as { note?: unknown }).note ?? "")).join("\n\n")
    : typeof notes === "string"
      ? notes
      : "";
  const text = raw
    .replace(/<\s*(br|\/p|\/li|\/h[1-6])\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!text) return null;
  return text.length > MAX_NOTES ? `${text.slice(0, MAX_NOTES).trimEnd()}…` : text;
}

export class UpdaterService {
  private current: UpdateStatus;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly feed: UpdateFeed | undefined,
    private readonly options: {
      currentVersion: string;
      emit: (status: UpdateStatus) => void;
      now?: () => Date;
    },
  ) {
    this.current = {
      phase: feed ? "idle" : "unsupported",
      currentVersion: options.currentVersion,
      availableVersion: null,
      progress: null,
      checkedAt: null,
      message: null,
      releaseNotes: null,
    };
    feed?.onProgress((percent) => {
      if (this.current.phase === "downloading")
        this.set({ progress: Math.max(0, Math.min(100, percent)) });
    });
  }

  get status(): UpdateStatus {
    return this.current;
  }

  /** Checks now and every 6 hours. */
  start(): void {
    if (!this.feed || this.timer) return;
    void this.check();
    this.timer = setInterval(() => void this.check(), CHECK_EVERY_MS);
    this.timer.unref?.();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Looks for a newer version and, when there is one, downloads it in the background. */
  async check(): Promise<UpdateStatus> {
    const feed = this.feed;
    const phase = this.current.phase;
    if (!feed || ["checking", "downloading", "ready", "installing"].includes(phase))
      return this.current;
    this.set({ phase: "checking", message: null });
    try {
      const found = await feed.checkForUpdates();
      const checkedAt = (this.options.now?.() ?? new Date()).toISOString();
      const version = found?.updateInfo.version;
      if (!version || !newerVersion(version, this.options.currentVersion)) {
        this.set({ phase: "up-to-date", checkedAt, availableVersion: null, releaseNotes: null });
        return this.current;
      }
      this.set({
        phase: "available",
        checkedAt,
        availableVersion: version,
        releaseNotes: releaseNotesText(found.updateInfo.releaseNotes),
      });
      void this.download();
    } catch {
      this.set({ phase: "error", message: "Couldn’t check for updates." });
    }
    return this.current;
  }

  async download(): Promise<UpdateStatus> {
    const feed = this.feed;
    if (!feed || this.current.phase !== "available") return this.current;
    this.set({ phase: "downloading", progress: 0 });
    try {
      await feed.downloadUpdate();
      this.set({ phase: "ready", progress: 100 });
    } catch {
      // The next check offers it again.
      this.set({ phase: "error", progress: null, message: "Couldn’t download the update." });
    }
    return this.current;
  }

  /** Restarts into the downloaded version. */
  install(): void {
    if (!this.feed || this.current.phase !== "ready") return;
    this.set({ phase: "installing" });
    this.stop();
    this.feed.quitAndInstall();
  }

  private set(patch: Partial<UpdateStatus>): void {
    this.current = { ...this.current, ...patch };
    this.options.emit(this.current);
  }
}
