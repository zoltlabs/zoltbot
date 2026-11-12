import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { expect, it } from "vitest";
import type { Chat } from "./topics.js";

it("packs workspaces, shares bases, filters settled and old chats, and retains all active states", () => {
  const window = {} as {
    commandMapLayout: (
      chats: Partial<Chat>[],
      workspaces: { id: string; name: string }[],
      positions?: object,
      now?: number,
    ) => {
      regions: { id: string; x: number; z: number }[];
      units: { chat: Partial<Chat> }[];
      bases: { id: string }[];
    };
  };
  vm.runInNewContext(
    readFileSync(new URL("../../views/command-map/layout.js", import.meta.url), "utf8"),
    { window },
  );
  const now = Date.parse("2026-01-02T12:00:00Z"),
    updatedAt = new Date(now).toISOString();
  const chats: Partial<Chat>[] = ["needs_you", "working", "review", "later", "settled", "idle"].map(
    (status, index) => ({
      id: String(index),
      title: status,
      status: status as Chat["status"],
      workspaceId: "project",
      worktree: { id: "shared", kind: "folder" },
      updatedAt,
    }),
  );
  chats.push(
    { id: "old", status: "idle", updatedAt: "2025-01-01T00:00:00Z" },
    { id: "other", status: "working", updatedAt },
  );
  const layout = window.commandMapLayout(
    chats,
    [{ id: "project", name: "Example" }],
    { project: { x: 20, z: 30 } },
    now,
  );
  expect(layout.units.map((unit) => unit.chat.id).sort()).toEqual([
    "0",
    "1",
    "2",
    "3",
    "5",
    "other",
  ]);
  expect(layout.bases).toHaveLength(1);
  expect(layout.bases[0]?.id).toBe("shared");
  expect(layout.regions.find((region) => region.id === "project")).toMatchObject({ x: 20, z: 30 });
  expect(layout.regions.some((region) => region.id === "other")).toBe(true);
});
it("loads bounded saved layout, groups and editable presets without accepting malformed state", () => {
  const window = {} as {
    commandMapSaved(input: unknown): {
      regions: Record<string, { x: number; z: number }>;
      groups: Record<string, string[]>;
      presets: string[];
    };
  };
  vm.runInNewContext(
    readFileSync(new URL("../../views/command-map/panels.js", import.meta.url), "utf8"),
    { window },
  );
  expect(window.commandMapSaved(null)).toEqual({
    regions: {},
    groups: {},
    presets: ["Rebase on main", "Run the tests"],
  });
  const saved = window.commandMapSaved({
    regions: { valid: { x: -10, z: 200 }, invalid: { x: Infinity, z: 0 } },
    groups: { 1: ["chat", "chat", 2] },
    presets: ["Check the working tree", "Run unit tests"],
  });
  expect(saved).toEqual({
    regions: { valid: { x: -10, z: 200 } },
    groups: { 1: ["chat"] },
    presets: ["Check the working tree", "Run unit tests"],
  });
});

const viewFolder = new URL("../../views/command-map/", import.meta.url);
function loadScripts(...names: string[]) {
  const window = {} as Record<string, unknown> & { CommandMap: Record<string, never> };
  for (const name of names)
    vm.runInNewContext(readFileSync(new URL(name, viewFolder), "utf8"), { window });
  return window.CommandMap as unknown as {
    skin: {
      palettes: Record<string, Record<string, unknown>>;
      quality: Record<string, Record<string, unknown>> & { slowMs: number; sampleFrames: number };
      builders: Record<string, string>;
      sounds: Record<string, unknown>;
    };
    unitState(chat: Partial<Chat>): { state: string; problem: boolean };
    waited(since: number, now: number): { short: string; long: string };
    waitingSince(chat: Partial<Chat>, requests: { chatId: string; createdAt: string }[]): number;
    statusLabels: Record<string, string>;
    Quality: new (
      skin: unknown,
      renderer: unknown,
      onChange: (level: string) => void,
    ) => {
      level: string;
      choose(choice: string): void;
      measure(elapsed: number, continuous: boolean): void;
    };
  };
}
const renderer = (name: string) => ({
  getContext: () => ({
    getExtension: () => ({ UNMASKED_RENDERER_WEBGL: 1 }),
    getParameter: () => name,
  }),
});

it("gives every chat status a distinct map state and a text label", () => {
  const map = loadScripts("states.js");
  const states = (["needs_you", "working", "review", "later", "idle"] as const).map(
    (status) => map.unitState({ status }).state,
  );
  expect(states).toEqual(["needs_you", "working", "review", "idle", "idle"]);
  for (const status of ["needs_you", "working", "review", "later", "idle", "settled"])
    expect(map.statusLabels[status]).toMatch(/\S/);
  expect(map.unitState({ status: "idle", lastTurn: { status: "failed" } }).problem).toBe(true);
  expect(map.unitState({ status: "working", problem: { kind: "rate_limited" } })).toEqual({
    state: "working",
    problem: true,
  });
  expect(map.unitState({ status: "working" }).problem).toBe(false);
});
it("reports how long a chat has waited from its oldest request", () => {
  const map = loadScripts("states.js"),
    now = Date.parse("2026-01-02T12:00:00Z");
  const chat = { id: "a", updatedAt: "2026-01-02T11:58:00Z" };
  expect(map.waitingSince(chat, [])).toBe(Date.parse(chat.updatedAt));
  const since = map.waitingSince(chat, [
    { chatId: "a", createdAt: "2026-01-02T11:30:00Z" },
    { chatId: "a", createdAt: "2026-01-02T11:10:00Z" },
    { chatId: "b", createdAt: "2026-01-02T09:00:00Z" },
  ]);
  expect(map.waited(since, now)).toEqual({ short: "50 min", long: "50 minutes" });
  expect(map.waited(now - 20000, now).short).toBe("now");
  expect(map.waited(now - 3 * 3600000, now)).toEqual({ short: "3 h", long: "3 hours" });
  expect(map.waited(now - 49 * 3600000, now).short).toBe("2 d");
});
it("starts at the low graphics level on a software renderer and steps down when frames are slow", () => {
  const map = loadScripts("skin.js", "quality.js"),
    changes: string[] = [];
  expect(new map.Quality(map.skin, renderer("Google SwiftShader"), () => {}).level).toBe("low");
  const quality = new map.Quality(map.skin, renderer("Apple M2"), (level) => changes.push(level));
  expect(quality.level).toBe("high");
  const frames = (ms: number, count: number, continuous = true) => {
    for (let index = 0; index < count; index++) quality.measure(ms, continuous);
  };
  frames(8, 200);
  frames(500, 200, false); // pauses between idle frames are not slow frames
  expect(changes).toEqual([]);
  frames(40, 12 + map.skin.quality.sampleFrames);
  expect(changes).toEqual(["medium"]);
  frames(40, 12 + map.skin.quality.sampleFrames);
  expect(changes).toEqual(["medium", "low"]);
  frames(40, 200);
  expect(changes).toEqual(["medium", "low"]);
  quality.choose("high"); // the owner's choice wins and is not stepped down
  frames(40, 200);
  expect(quality.level).toBe("high");
  quality.choose("auto");
  expect(quality.level).toBe("high");
});
it("turns off depth of field and ambient occlusion first, then shadows and bloom", () => {
  const { quality } = loadScripts("skin.js").skin;
  expect(quality.high).toMatchObject({
    depthOfField: true,
    ambientOcclusion: true,
    shadows: true,
    bloom: true,
  });
  expect(quality.medium).toMatchObject({
    depthOfField: false,
    ambientOcclusion: false,
    shadows: true,
    bloom: true,
  });
  expect(quality.low).toMatchObject({
    depthOfField: false,
    ambientOcclusion: false,
    shadows: false,
    bloom: false,
  });
});
it("keeps day and night palettes in step and sound off unless saved on", () => {
  const { skin } = loadScripts("skin.js");
  expect(Object.keys(skin.palettes.day ?? {}).sort()).toEqual(
    Object.keys(skin.palettes.night ?? {}).sort(),
  );
  expect(Object.keys(skin.sounds).sort()).toEqual(["failed", "finished", "needsYou"]);
  const window = {} as { commandMapSaved(input: unknown): { sound?: boolean; quality?: string } };
  vm.runInNewContext(readFileSync(new URL("panels.js", viewFolder), "utf8"), { window });
  expect(window.commandMapSaved({}).sound).toBeUndefined();
  expect(window.commandMapSaved({ sound: "yes", quality: "ultra" })).toMatchObject({
    sound: undefined,
    quality: undefined,
  });
  expect(window.commandMapSaved({ sound: true, quality: "medium" })).toMatchObject({
    sound: true,
    quality: "medium",
  });
});
it("places 200 chats without overlap, inside their regions, with regions apart", () => {
  const window = {} as {
    commandMapLayout: (
      chats: Partial<Chat>[],
      workspaces: { id: string; name: string }[],
    ) => {
      regions: { id: string; x: number; z: number; w: number; d: number }[];
      units: { region: string; x: number; z: number }[];
    };
  };
  vm.runInNewContext(readFileSync(new URL("layout.js", viewFolder), "utf8"), { window });
  const updatedAt = new Date().toISOString();
  const chats: Partial<Chat>[] = Array.from({ length: 200 }, (_, index) => ({
    id: `chat-${index}`,
    status: "working",
    workspaceId: `space-${index % 7}`,
    worktree: index % 5 ? { id: `tree-${index % 23}`, kind: "worktree" } : undefined,
    updatedAt,
  }));
  const layout = window.commandMapLayout(
    chats,
    Array.from({ length: 7 }, (_, index) => ({ id: `space-${index}`, name: `Space ${index}` })),
  );
  expect(layout.units).toHaveLength(200);
  expect(
    new Set(layout.units.map((unit) => `${unit.x.toFixed(2)}:${unit.z.toFixed(2)}`)).size,
  ).toBe(200);
  for (const unit of layout.units) {
    const region = layout.regions.find((item) => item.id === unit.region);
    expect(region).toBeDefined();
    if (!region) continue;
    expect(unit.x).toBeGreaterThan(region.x);
    expect(unit.x).toBeLessThan(region.x + region.w);
    expect(unit.z).toBeGreaterThan(region.z);
    expect(unit.z).toBeLessThan(region.z + region.d);
  }
  for (const a of layout.regions)
    for (const b of layout.regions)
      if (a !== b)
        expect(a.x + a.w <= b.x || b.x + b.w <= a.x || a.z + a.d <= b.z || b.z + b.d <= a.z).toBe(
          true,
        );
});
it("ships a readable folder under 5 MB that loads nothing from the network", () => {
  const files = readdirSync(viewFolder, { recursive: true, withFileTypes: true }).filter((entry) =>
    entry.isFile(),
  );
  let total = 0;
  for (const entry of files) {
    const file = path.join(entry.parentPath, entry.name),
      bytes = readFileSync(file);
    total += bytes.length;
    if (file.includes(`${path.sep}vendor${path.sep}`)) continue;
    if (/\.(js|css|html)$/.test(entry.name)) {
      const text = bytes.toString("utf8");
      expect(text.split("\n").length, entry.name).toBeLessThanOrEqual(800);
      expect(Math.max(...text.split("\n").map((line) => line.length)), entry.name).toBeLessThan(
        400,
      );
      expect(text, entry.name).not.toMatch(/https?:\/\/(?!www\.w3\.org\/2000\/svg)/);
    }
  }
  expect(total).toBeLessThan(5 * 1024 * 1024);
  const manifest = JSON.parse(readFileSync(new URL("view.json", viewFolder), "utf8"));
  expect(manifest.version).toBe("2.0.0");
  expect(manifest.permissions).toEqual(["read", "act", "approve"]);
});
