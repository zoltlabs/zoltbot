import { readFileSync } from "node:fs";
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
