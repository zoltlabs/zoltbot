import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { expect, it } from "vitest";
import type { Chat } from "./topics.js";

const viewFolder = new URL("../../views/command-map/", import.meta.url);

function loadScripts(...names: string[]) {
  const window = { CommandMap: {} } as {
    CommandMap: {
      skin: { sounds: Record<string, unknown> };
      unitState(chat: Partial<Chat>): { state: string; problem: boolean };
      waited(since: number, now: number): { short: string; long: string };
      waitingSince(chat: Partial<Chat>, requests: { chatId: string; createdAt: string }[]): number;
      statusLabels: Record<string, string>;
    };
    commandMapSaved(input: unknown): { presets: string[]; sound?: boolean };
    commandMapLayout(
      chats: Partial<Chat>[],
      workspaces: { id: string; name: string }[],
      now?: number,
    ): {
      cities: { id: string; name: string; q: number; r: number }[];
      districts: { id: string; city: string; q: number; r: number }[];
      units: { chat: Partial<Chat>; city: string; q: number; r: number }[];
      land: { city: string; q: number; r: number }[];
    };
  };
  for (const name of names)
    vm.runInNewContext(readFileSync(new URL(name, viewFolder), "utf8"), { window });
  return window;
}

it("groups chats by city, shares worktree districts, and keeps active chats visible", () => {
  const { commandMapLayout } = loadScripts("layout.js");
  const now = Date.parse("2026-01-02T12:00:00Z");
  const updatedAt = new Date(now).toISOString();
  const statuses = ["needs_you", "working", "review", "later", "settled", "idle"] as const;
  const chats: Partial<Chat>[] = statuses.map((status) => ({
    id: status,
    status,
    workspaceId: "project",
    worktree: { id: "shared", kind: "folder" },
    updatedAt,
  }));
  chats.push(
    { id: "old-idle", status: "idle", updatedAt: "2025-01-01T00:00:00Z" },
    { id: "old-working", status: "working", updatedAt: "2025-01-01T00:00:00Z" },
  );
  const layout = commandMapLayout(chats, [{ id: "project", name: "Example" }], now);
  expect(layout.units.map(({ chat }) => chat.id).sort()).toEqual([
    "idle",
    "later",
    "needs_you",
    "old-working",
    "review",
    "working",
  ]);
  expect(layout.districts).toMatchObject([{ id: "shared", city: "project" }]);
  expect(layout.cities).toMatchObject([
    { id: "other", name: "Other" },
    { id: "project", name: "Example" },
  ]);
});

it("loads bounded saved messages and enables sound only when explicitly saved", () => {
  const { commandMapSaved, CommandMap } = loadScripts("skin.js", "requests.js");
  expect(commandMapSaved(null)).toEqual({
    presets: ["Rebase on main", "Run the tests"],
    sound: undefined,
  });
  expect(commandMapSaved({ presets: [null, " ", "x".repeat(8001)], sound: "yes" })).toEqual(
    commandMapSaved(null),
  );
  const messages = Array.from({ length: 8 }, (_, index) => `Send message ${index}`);
  expect(commandMapSaved({ presets: messages, sound: true })).toEqual({
    presets: messages.slice(0, 6),
    sound: true,
  });
  expect(Object.keys(CommandMap.skin.sounds).sort()).toEqual(["failed", "finished", "needsYou"]);
});

it("gives every chat status a distinct map state and a text label", () => {
  const { CommandMap: map } = loadScripts("states.js");
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
  const { CommandMap: map } = loadScripts("states.js"),
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
it("places 200 chats in separate hexes on land owned by their cities", () => {
  const { commandMapLayout } = loadScripts("layout.js");
  const chats: Partial<Chat>[] = Array.from({ length: 200 }, (_, index) => ({
    id: `chat-${index}`,
    status: "working",
    workspaceId: `space-${index % 7}`,
    ...(index % 5 ? { worktree: { id: `tree-${index % 23}`, kind: "worktree" as const } } : {}),
  }));
  const layout = commandMapLayout(
    chats,
    Array.from({ length: 7 }, (_, index) => ({ id: `space-${index}`, name: `Space ${index}` })),
  );
  const key = ({ q, r }: { q: number; r: number }) => `${q}:${r}`;
  const land = new Map(layout.land.map((tile) => [key(tile), tile.city]));
  const occupants = [...layout.cities, ...layout.districts, ...layout.units];
  expect(layout.units).toHaveLength(200);
  expect(new Set(occupants.map(key)).size).toBe(occupants.length);
  expect(land.size).toBe(layout.land.length);
  for (const piece of [...layout.units, ...layout.districts])
    expect(land.get(key(piece))).toBe(piece.city);
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
  expect(manifest.version).toBe("2.1.0");
  expect(manifest.permissions).toEqual(["read", "act", "approve"]);
});
