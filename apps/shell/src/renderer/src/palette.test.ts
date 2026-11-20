import { describe, expect, it } from "vitest";
import { matchScore, type PaletteItem, rankPalette, rememberRecent } from "./palette";

const item = (id: string, group: PaletteItem["group"], label: string, detail?: string) => ({
  id,
  group,
  label,
  ...(detail ? { detail } : {}),
  run: () => undefined,
});

describe("matchScore", () => {
  it("ranks a prefix over a word start over text inside over letters in order", () => {
    const prefix = matchScore("rel", "Release notes") ?? 0;
    const word = matchScore("not", "Release notes") ?? 0;
    const inside = matchScore("eas", "Release notes") ?? 0;
    const letters = matchScore("rns", "Release notes") ?? 0;
    expect(prefix).toBeGreaterThan(word);
    expect(word).toBeGreaterThan(inside);
    expect(inside).toBeGreaterThan(letters);
    expect(letters).toBeGreaterThan(0);
  });

  it("ignores case and returns null when letters are missing", () => {
    expect(matchScore("TASKS", "Tasks")).toBeGreaterThan(900);
    expect(matchScore("xyz", "Tasks")).toBeNull();
    expect(matchScore("  ", "anything")).toBe(0);
  });

  it("prefers the shorter of two prefix matches", () => {
    expect(matchScore("map", "Map") ?? 0).toBeGreaterThan(matchScore("map", "Map settings") ?? 0);
  });
});

describe("rankPalette", () => {
  const items = [
    item("chat:1", "chats", "Release notes", "Website"),
    item("chat:2", "chats", "Bug triage"),
    item("channel:1", "channels", "Releases"),
    item("page:tasks", "pages", "Tasks"),
    item("command:new", "commands", "New chat"),
  ];

  it("shows recent items first, then each group, when nothing is typed", () => {
    const sections = rankPalette(items, "", ["page:tasks", "gone", "chat:2"]);
    expect(sections.map((section) => section.group)).toEqual([
      "recent",
      "chats",
      "channels",
      "commands",
    ]);
    expect(sections[0]?.items.map((entry) => entry.id)).toEqual(["page:tasks", "chat:2"]);
    expect(sections[1]?.items.map((entry) => entry.id)).toEqual(["chat:1"]);
  });

  it("orders groups by their best match and drops groups with none", () => {
    const sections = rankPalette(items, "releases", []);
    expect(sections.map((section) => section.group)).toEqual(["channels", "chats"]);
    expect(rankPalette(items, "bug", []).map((section) => section.group)).toEqual(["chats"]);
  });

  it("matches the detail line at a lower weight", () => {
    const sections = rankPalette(items, "website", []);
    expect(sections[0]?.items[0]?.id).toBe("chat:1");
    expect(matchScore("website", "Website")).toBeGreaterThan(0);
  });

  it("never lets a recent item outrank a better match", () => {
    const both = [item("chat:map", "chats", "Map review"), item("page:map", "pages", "Map")];
    const sections = rankPalette(both, "map", ["chat:map"]);
    expect(sections.map((section) => section.group)).toEqual(["pages", "chats"]);
  });

  it("puts a recent item ahead of an equal match", () => {
    const twins = [item("a", "chats", "Notes"), item("b", "chats", "Notes")];
    expect(rankPalette(twins, "notes", ["b"])[0]?.items.map((entry) => entry.id)).toEqual([
      "b",
      "a",
    ]);
  });
});

describe("rememberRecent", () => {
  it("moves an item to the front without duplicates and keeps the limit", () => {
    expect(rememberRecent(["a", "b", "c"], "b")).toEqual(["b", "a", "c"]);
    expect(rememberRecent(["a", "b"], "c", 2)).toEqual(["c", "a"]);
  });
});
