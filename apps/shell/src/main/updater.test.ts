import { describe, expect, it, vi } from "vitest";
import type { UpdateStatus } from "../shared/ipc";
import { attachDecision } from "./daemon-host";
import { newerVersion, releaseNotesText, type UpdateFeed, UpdaterService } from "./updater";

/** A feed whose answers the test controls. */
function fakeFeed(version: string | null, notes: unknown = "<p>Faster <b>search</b></p>") {
  let progress: (percent: number) => void = () => undefined;
  let finish: () => void = () => undefined;
  let fail: (error: Error) => void = () => undefined;
  const feed: UpdateFeed & { installed: boolean } = {
    installed: false,
    checkForUpdates: vi.fn(async () =>
      version ? { updateInfo: { version, releaseNotes: notes } } : null,
    ),
    downloadUpdate: vi.fn(
      () =>
        new Promise((resolve, reject) => {
          finish = () => resolve(undefined);
          fail = reject;
        }),
    ),
    quitAndInstall: () => {
      feed.installed = true;
    },
    onProgress: (listener) => {
      progress = listener;
    },
  };
  return {
    feed,
    progress: (percent: number) => progress(percent),
    finish: () => finish(),
    fail: () => fail(new Error("network")),
  };
}

function service(feed: UpdateFeed | undefined) {
  const seen: UpdateStatus[] = [];
  const updater = new UpdaterService(feed, {
    currentVersion: "1.2.0",
    emit: (status) => seen.push(status),
    now: () => new Date("2026-11-21T06:00:00Z"),
  });
  return { updater, phases: () => seen.map((status) => status.phase) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("UpdaterService", () => {
  it("stays unsupported without a feed, as in an unsigned build", async () => {
    const { updater } = service(undefined);
    expect(updater.status.phase).toBe("unsupported");
    expect((await updater.check()).phase).toBe("unsupported");
    updater.install();
    expect(updater.status.phase).toBe("unsupported");
  });

  it("finds a newer version, downloads it in the background and restarts into it", async () => {
    const fake = fakeFeed("1.3.0");
    const { updater, phases } = service(fake.feed);
    await updater.check();
    expect(updater.status).toMatchObject({
      availableVersion: "1.3.0",
      releaseNotes: "Faster search",
      checkedAt: "2026-11-21T06:00:00.000Z",
    });
    expect(updater.status.phase).toBe("downloading");
    fake.progress(42.4);
    expect(updater.status.progress).toBe(42.4);
    // Restarting before the download finishes does nothing.
    updater.install();
    expect(fake.feed.installed).toBe(false);
    fake.finish();
    await settle();
    expect(updater.status.phase).toBe("ready");
    updater.install();
    expect(fake.feed.installed).toBe(true);
    expect(phases()).toEqual([
      "checking",
      "available",
      "downloading",
      "downloading",
      "ready",
      "installing",
    ]);
  });

  it("reports up to date when the feed has nothing newer", async () => {
    for (const version of [null, "1.2.0", "1.1.9", "1.2.0-beta.1"]) {
      const { updater } = service(fakeFeed(version).feed);
      expect((await updater.check()).phase).toBe("up-to-date");
    }
  });

  it("doesn't check again while a download runs, and offers it again after a failed one", async () => {
    const fake = fakeFeed("1.3.0");
    const { updater } = service(fake.feed);
    await updater.check();
    await updater.check();
    expect(fake.feed.checkForUpdates).toHaveBeenCalledTimes(1);
    fake.fail();
    await settle();
    expect(updater.status).toMatchObject({
      phase: "error",
      message: "Couldn’t download the update.",
    });
    await updater.check();
    expect(fake.feed.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(updater.status.phase).toBe("downloading");
  });

  it("reports a failed check", async () => {
    const fake = fakeFeed("1.3.0");
    fake.feed.checkForUpdates = async () => {
      throw new Error("offline");
    };
    const { updater } = service(fake.feed);
    expect(await updater.check()).toMatchObject({
      phase: "error",
      message: "Couldn’t check for updates.",
    });
  });
});

describe("newerVersion", () => {
  it("compares major, minor and patch, with releases after their pre-releases", () => {
    expect(newerVersion("1.10.0", "1.9.9")).toBe(true);
    expect(newerVersion("v2.0.0", "1.99.0")).toBe(true);
    expect(newerVersion("1.2.0", "1.2.0")).toBe(false);
    expect(newerVersion("1.2.0", "1.2.0-beta.2")).toBe(true);
    expect(newerVersion("1.2.0-beta.2", "1.2.0")).toBe(false);
    expect(newerVersion("1.2.0-beta.3", "1.2.0-beta.2")).toBe(true);
  });
});

describe("releaseNotesText", () => {
  it("turns a release body into plain text", () => {
    expect(releaseNotesText("<ul><li>One &amp; two</li><li>Three</li></ul>")).toBe(
      "• One & two\n• Three",
    );
    expect(releaseNotesText([{ note: "A" }, { note: "B" }])).toBe("A\n\nB");
    expect(releaseNotesText(undefined)).toBeNull();
    expect(releaseNotesText("x".repeat(5000))?.length).toBe(4001);
  });
});

describe("attachDecision", () => {
  const app = { protocolVersion: 1, version: "1.3.0" };
  it("attaches to a daemon as new as the app", () => {
    expect(attachDecision({ result: { protocolVersion: 1, version: "1.3.0" } }, app)).toBe(
      "attach",
    );
    // A dev app names no version: any daemon that speaks the protocol will do.
    expect(
      attachDecision(
        { result: { protocolVersion: 1, version: "0.1.0" } },
        { ...app, version: undefined },
      ),
    ).toBe("attach");
  });

  it("replaces a daemon older than the updated app", () => {
    expect(attachDecision({ result: { protocolVersion: 1, version: "1.2.0" } }, app)).toBe(
      "replace",
    );
    expect(attachDecision({ result: { protocolVersion: 0, version: "1.3.0" } }, app)).toBe(
      "replace",
    );
    expect(attachDecision({ result: { version: "1.3.0" } }, app)).toBe("replace");
  });

  it("attaches to a daemon that names no version", () => {
    expect(attachDecision({ result: { protocolVersion: 1, version: null } }, app)).toBe("attach");
  });

  it("leaves a daemon that refuses the hello alone", () => {
    expect(attachDecision({ error: { code: -32001 } }, app)).toBe("refused");
  });
});
