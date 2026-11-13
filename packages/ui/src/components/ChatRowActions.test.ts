import { type ComponentType, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { mergeSeen } from "../inbox/read-state.js";
import { rowStatuses } from "../workspaces/activity.js";
import { teamBelow } from "../workspaces/manager-view.js";
import { clearSeen, markSeen } from "../workspaces/seen.js";
import { ChatRowShell, createThreadActions, isManageableThread } from "./ChatRowActions.js";

describe("createThreadActions", () => {
  it("dispatches pin, unread/read, rename, archive, and delete RPCs", async () => {
    const calls: { method: string; params: unknown; commandId?: string }[] = [];
    const call = async (method: string, params: unknown, commandId?: string) => {
      calls.push({ method, params, ...(commandId ? { commandId } : {}) });
      return { ok: true };
    };
    const thread = {
      id: "t1",
      title: "Alpha chat",
      pinned: false,
      archived: false,
      wakeUnreadAt: "2026-11-12T10:00:00.000Z",
    };
    const turns = [{ id: "turn1", threadId: "t1", endedAt: "2026-11-12T09:00:00.000Z" }];

    const unreadActions = createThreadActions({
      thread,
      rowStatus: "idle",
      turns,
      call,
    });
    markSeen("t1", "2026-11-12T09:30:00.000Z");
    await unreadActions.onTogglePin();
    await unreadActions.onToggleUnread();
    await unreadActions.onRename("  Renamed chat  ");
    await unreadActions.onToggleArchive();
    await unreadActions.onDelete();

    expect(calls.map((entry) => [entry.method, entry.params])).toEqual([
      ["thread.pin", { id: "t1", pinned: true }],
      ["thread.markUnread", { id: "t1" }],
      ["thread.rename", { id: "t1", title: "Renamed chat" }],
      ["thread.archive", { id: "t1", confirmed: true }],
      ["thread.delete", { id: "t1", confirmed: true }],
    ]);

    calls.length = 0;
    const readActions = createThreadActions({
      thread: { ...thread, pinned: true, archived: true },
      rowStatus: "unread",
      turns,
      call,
    });
    await readActions.onTogglePin();
    await readActions.onToggleUnread();
    await readActions.onToggleArchive();

    expect(calls[0]).toMatchObject({ method: "thread.pin", params: { id: "t1", pinned: false } });
    expect(calls[1]?.method).toBe("thread.markRead");
    expect((calls[1]?.params as { id: string; at: string }).id).toBe("t1");
    expect((calls[1]?.params as { id: string; at: string }).at >= "2026-11-12T10:00:00.000Z").toBe(
      true,
    );
    expect(calls[2]).toMatchObject({ method: "thread.unarchive", params: { id: "t1" } });
    clearSeen("t1");
  });
});

describe("isManageableThread", () => {
  it("excludes task threads, chief thread, and compare member threads", () => {
    expect(isManageableThread({ id: "t1", kind: "side" })).toBe(true);
    expect(isManageableThread({ id: "t2", kind: "task" })).toBe(false);
    expect(isManageableThread({ id: "t3", kind: "side", taskId: "task1" })).toBe(false);
    expect(isManageableThread({ id: "chief", kind: "side" }, { chiefId: "chief" })).toBe(false);
    expect(
      isManageableThread({ id: "cmp", kind: "side" }, { compareMembers: [{ threadId: "cmp" }] }),
    ).toBe(false);
  });
});

describe("unread read-state sync", () => {
  it("keeps wakeUnreadAt visible over stale local seen timestamps until marked read", () => {
    const thread = {
      id: "t1",
      wakeUnreadAt: "2026-11-12T12:00:00.000Z",
      lastReadAt: "2026-11-12T10:00:00.000Z",
    };
    const mergedUnread = mergeSeen({ t1: "2026-11-12T11:00:00.000Z" }, [thread]);
    expect(rowStatuses({ thread: [thread] }, mergedUnread).get("t1")).toBe("unread");

    const readThread = {
      id: "t1",
      wakeUnreadAt: "2026-11-12T12:00:00.000Z",
      lastReadAt: "2026-11-12T12:00:00.000Z",
    };
    const mergedRead = mergeSeen({}, [readThread]);
    expect(rowStatuses({ thread: [readThread] }, mergedRead).get("t1")).toBe("idle");
  });
});

describe("pinned ordering & ChatRowShell markup", () => {
  it("sorts pinned chats ahead of newer unpinned chats in teamBelow", () => {
    const result = teamBelow(
      { type: "project", id: "p1" },
      {
        teams: [{ id: "s1", projectId: "p1", name: "Core" }],
        threads: [
          {
            id: "newer",
            kind: "side",
            title: "Newer",
            agentId: "a1",
            node: { type: "project", id: "p1" },
            lastActivityAt: "2026-11-12T12:00:00.000Z",
          },
          {
            id: "older-pinned",
            kind: "side",
            title: "Pinned",
            agentId: "a1",
            pinned: true,
            node: { type: "project", id: "p1" },
            lastActivityAt: "2026-11-12T08:00:00.000Z",
          },
        ],
        profiles: [{ id: "a1", name: "Agent" }],
        statuses: new Map([
          ["newer", "idle"],
          ["older-pinned", "idle"],
        ]),
        queued: new Set(),
      },
    );
    expect(result.chats.map((chat) => chat.id)).toEqual(["older-pinned", "newer"]);
    expect(Object.keys(result.chats[0] ?? {})).not.toContain("pinned");
  });

  it("renders Pin and More buttons as siblings beside the row button", () => {
    const Shell = ChatRowShell as ComponentType<
      Omit<Parameters<typeof ChatRowShell>[0], "children">
    >;
    const html = renderToStaticMarkup(
      createElement(
        Shell,
        {
          title: "Alpha chat",
          actions: createThreadActions({
            thread: { id: "t1", title: "Alpha chat", pinned: false },
            call: async () => ({}),
          }),
        },
        createElement("button", { type: "button", className: "scope-chat" }, "Alpha chat"),
      ),
    );
    expect(html).toContain('aria-label="Pin Alpha chat"');
    expect(html).toContain('aria-label="More actions for Alpha chat"');
    expect(html).not.toContain('aria-pressed="false"');
    expect(html.indexOf("</button>")).toBeLessThan(html.indexOf('aria-label="Pin Alpha chat"'));
  });
});
