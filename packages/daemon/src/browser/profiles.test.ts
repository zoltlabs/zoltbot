import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { handle } from "@zoltbot/core";
import { expect, it } from "vitest";
import { at, runtimeFixture } from "../../../../tools/fakes/src/runtime-fixture.js";
import { settingsApi } from "../settings-api.js";
import { PROFILE_MARKER, profileApi } from "./profiles.js";
import { browserBinding, materializeBrowser, validateBrowserArgs } from "./runtime.js";

const launch = { agentId: "profile", agentName: "Fixture", threadId: "thread" };

function answer(
  f: Awaited<ReturnType<typeof runtimeFixture>>,
  interactionId: string,
  option: string,
) {
  f.store.dispatch(`answer:${interactionId}`, (state) =>
    handle(
      state,
      {
        type: "answer",
        id: interactionId,
        version: 1,
        answer: {
          action: "accept",
          answers: { choice: { options: [option] } },
          by: { kind: "human", id: "local-owner" },
          at,
        },
      },
      { commandId: `answer:${interactionId}`, at, actor: { kind: "human", id: "local-owner" } },
    ),
  );
}

it("asks once, records Allow, and keeps the profile folder for later launches", async () => {
  const f = await runtimeFixture();
  try {
    const profiles = profileApi({ store: f.store, dataDir: f.root });
    // The first launch asks the owner and runs isolated.
    expect(profiles.forLaunch(launch)).toBeUndefined();
    const card = f.store
      .snapshot(["interaction"])
      .interaction?.find((row) => String(row.id).startsWith("browser-profile:profile:"));
    expect(card).toMatchObject({
      title: "Let Fixture keep a browser profile?",
      state: "pending",
      items: [{ prompt: "It stays signed in to sites it visits." }],
    });
    // A second launch while the card waits doesn't ask again.
    expect(profiles.forLaunch(launch)).toBeUndefined();
    expect(
      f.store
        .snapshot(["interaction"])
        .interaction?.filter((row) => String(row.id).startsWith("browser-profile:")),
    ).toHaveLength(1);

    answer(f, String(card?.id), "allow");
    const kept = profiles.get("profile");
    expect(kept).toMatchObject({ agentId: "profile", name: "Fixture" });
    const used = profiles.forLaunch(launch);
    expect(used?.dir).toBe(path.join(f.root, "browser-profiles", String(kept?.id)));
    expect(existsSync(path.join(String(used?.dir), PROFILE_MARKER))).toBe(true);
  } finally {
    f.close();
  }
});

it("Not now runs isolated and doesn't ask again for a week", async () => {
  const f = await runtimeFixture();
  try {
    const profiles = profileApi({ store: f.store, dataDir: f.root });
    profiles.forLaunch(launch);
    const card = f.store
      .snapshot(["interaction"])
      .interaction?.find((row) => String(row.id).startsWith("browser-profile:"));
    answer(f, String(card?.id), "not-now");
    expect(profiles.forLaunch(launch)).toBeUndefined();
    expect(profiles.get("profile")).toBeNull();
    expect(
      f.store
        .snapshot(["interaction"])
        .interaction?.filter((row) => String(row.id).startsWith("browser-profile:")),
    ).toHaveLength(1);
  } finally {
    f.close();
  }
});

it("Clear needs confirmation, deletes the folder and audits the owner's choice", async () => {
  const f = await runtimeFixture();
  try {
    const profiles = profileApi({ store: f.store, dataDir: f.root });
    profiles.forLaunch(launch);
    const card = f.store
      .snapshot(["interaction"])
      .interaction?.find((row) => String(row.id).startsWith("browser-profile:"));
    answer(f, String(card?.id), "allow");
    const used = profiles.forLaunch(launch);
    writeFileSync(path.join(String(used?.dir), "Cookies"), "signed in");

    await expect(profiles.clear("profile", false)).rejects.toThrow("confirmation_required");
    // While a browser holds the folder, Clear refuses rather than leave sign-ins behind.
    symlinkSync("host-1", path.join(String(used?.dir), "SingletonLock"));
    await expect(profiles.clear("profile", true)).rejects.toThrow("browser_profile_in_use");
    expect(existsSync(path.join(String(used?.dir), PROFILE_MARKER))).toBe(true);
    rmSync(path.join(String(used?.dir), "SingletonLock"));
    expect(await profiles.clear("profile", true)).toEqual({ ok: true, cleared: true });
    expect(existsSync(String(used?.dir))).toBe(false);
    expect(profiles.get("profile")).toBeNull();
    expect(f.store.snapshot(["audit"]).audit).toContainEqual(
      expect.objectContaining({ action: "browser.profile.clear", target: "profile" }),
    );
    // A later launch asks again.
    profiles.forLaunch(launch);
    expect(
      f.store
        .snapshot(["interaction"])
        .interaction?.filter((row) => String(row.id).startsWith("browser-profile:")),
    ).toHaveLength(2);
  } finally {
    f.close();
  }
});

it("never takes a profile from tool input or plain settings", async () => {
  for (const arg of [
    "--profile=/tmp/x",
    "--profile",
    "--user-data-dir=/tmp/x",
    "--persistent",
    "--config=/tmp/c.json",
  ])
    expect(() => validateBrowserArgs(["open", "about:blank", arg])).toThrow(
      "browser_override_denied",
    );
  const f = await runtimeFixture();
  try {
    const settings = settingsApi({
      store: f.store,
      privacy: { prepareData: async () => () => {} } as never,
      redactor: { redact: (text: string) => text } as never,
      publish: () => {},
    });
    await expect(
      settings("settings.set", {
        key: "browser.profile.profile",
        value: { state: "kept", id: "aaaaaaaa-1" },
      }),
    ).rejects.toThrow();
    // A binding pointing outside the daemon's profile folder never materializes.
    mkdirSync(path.join(f.root, "work"), { recursive: true });
    const binding = browserBinding(
      f.root,
      path.join(f.root, "work"),
      { mode: "background" },
      {
        id: "aaaaaaaa-1",
        dir: "/tmp/elsewhere",
      },
    );
    expect(() => materializeBrowser(binding)).toThrow("browser_profile_invalid");
    // A kept profile's launcher switches config only while the folder is marked.
    const dir = path.join(f.root, "browser-profiles", "bbbbbbbb-2");
    const kept = browserBinding(
      f.root,
      path.join(f.root, "work"),
      { mode: "background" },
      {
        id: "bbbbbbbb-2",
        dir,
      },
    );
    materializeBrowser(kept);
    const source = readFileSync(`${kept.launcher}.mjs`, "utf8");
    expect(source).toContain(path.join(dir, PROFILE_MARKER));
    expect(source).toContain("config-profile.json");
  } finally {
    f.close();
  }
});
