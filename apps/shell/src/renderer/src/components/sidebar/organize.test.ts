import { describe, expect, it } from "vitest";
import type { BotProfile } from "../../data";
import { ALL_PROJECTS, arrangeBots, groupHeadingAt, projectsOf } from "./organize";

const bot = (id: string, extra: Partial<BotProfile> = {}) =>
  ({ id, name: id, companyRole: "chat", depth: 0, ...extra }) as BotProfile;

const bots = [
  bot("ceo", { companyRole: "ceo", projectId: "p", projectName: "Site", updatedAt: "2026-01-01" }),
  bot("beta", { projectId: "p", projectName: "Site", updatedAt: "2026-01-03" }),
  bot("alpha", { projectId: "p", projectName: "Site", updatedAt: "2026-01-02" }),
  bot("zeta", { updatedAt: "2026-01-05" }),
  bot("gamma", { updatedAt: "2026-01-04", pinned: true }),
];
const ids = (list: BotProfile[]) => list.map((entry) => entry.id);
const none = () => false;

describe("arrangeBots", () => {
  it("sorts chats by recent activity, keeping projects and agents in place", () => {
    const { rest } = arrangeBots(bots, { sort: "recent", project: ALL_PROJECTS, isUnread: none });
    expect(ids(rest)).toEqual(["ceo", "beta", "alpha", "gamma", "zeta"]);
  });

  it("sorts by name with pinned chats first", () => {
    const { rest } = arrangeBots(bots, { sort: "name", project: ALL_PROJECTS, isUnread: none });
    expect(ids(rest)).toEqual(["ceo", "alpha", "beta", "gamma", "zeta"]);
  });

  it("pulls unread chats into their own group, newest first, only by recent activity", () => {
    const isUnread = (entry: BotProfile) => entry.id === "alpha" || entry.id === "zeta";
    const recent = arrangeBots(bots, { sort: "recent", project: ALL_PROJECTS, isUnread });
    expect(ids(recent.unread)).toEqual(["zeta", "alpha"]);
    expect(ids(recent.rest)).toEqual(["ceo", "beta", "gamma"]);
    expect(arrangeBots(bots, { sort: "name", project: ALL_PROJECTS, isUnread }).unread).toEqual([]);
  });

  it("filters to one project, or to chats outside any", () => {
    const site = arrangeBots(bots, {
      sort: "recent",
      project: { kind: "project", projectId: "p" },
      isUnread: none,
    });
    expect(ids(site.rest)).toEqual(["ceo", "beta", "alpha"]);
    const loose = arrangeBots(bots, {
      sort: "recent",
      project: { kind: "project", projectId: null },
      isUnread: none,
    });
    expect(ids(loose.rest)).toEqual(["gamma", "zeta"]);
    expect(projectsOf(bots)).toEqual([
      { id: "p", name: "Site" },
      { id: null, name: "No project" },
    ]);
  });
});

describe("groupHeadingAt", () => {
  it("heads the unread group, then each project", () => {
    const rows = [bot("u"), bot("a", { projectId: "p", projectName: "Site" }), bot("b")];
    const at = (index: number) => rows[index];
    expect(groupHeadingAt(at, 0, 1)?.name).toBe("Unread");
    expect(groupHeadingAt(at, 1, 1)?.name).toBe("Site");
    expect(groupHeadingAt(at, 2, 1)?.name).toBe("Chats");
    // Without unread rows, chats before any project need no heading.
    expect(groupHeadingAt((index) => rows.slice(2)[index], 0, 0)).toBeUndefined();
  });
});
