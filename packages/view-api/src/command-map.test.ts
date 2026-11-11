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
