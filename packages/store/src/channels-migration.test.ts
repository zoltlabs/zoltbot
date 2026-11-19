import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { channelEvent } from "@zoltbot/core";
import { expect, it } from "vitest";
import { openStore } from "./index.js";

it("stores channels, posts and requests and reads them back after reopening", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "channels-"));
  const file = path.join(root, "store.db");
  const at = "2026-11-19T12:00:00.000Z";
  const context = { commandId: "c1", at, actor: { kind: "system" as const, id: "test" } };
  try {
    const store = await openStore(file);
    try {
      store.dispatch("c1", () => ({
        events: [
          channelEvent(
            "channel",
            {
              id: "channel-team-pay",
              projectId: "co",
              teamId: "pay",
              kind: "team",
              name: "payments",
              leadThreadId: "lead",
              memberThreadIds: ["lead", "mira"],
              createdAt: at,
              updatedAt: at,
            },
            context,
            "created",
            0,
          ),
          channelEvent(
            "channelRequest",
            {
              id: "request-p1",
              channelId: "channel-team-pay",
              projectId: "co",
              postId: "p1",
              title: "Ship refunds",
              leadThreadId: "lead",
              state: "open",
              revision: 1,
              createdAt: at,
              updatedAt: at,
            },
            context,
            "created",
            1,
          ),
        ],
        result: {},
      }));
    } finally {
      store.close();
    }
    const reopened = await openStore(file);
    try {
      expect(reopened.snapshot(["channel"]).channel?.[0]).toMatchObject({ name: "payments" });
      expect(
        reopened.database
          .prepare("SELECT project_id, lead_thread_id FROM channels WHERE id=?")
          .get("channel-team-pay"),
      ).toEqual({ project_id: "co", lead_thread_id: "lead" });
      expect(
        reopened.database
          .prepare("SELECT state FROM channel_requests WHERE id=?")
          .get("request-p1"),
      ).toEqual({ state: "open" });
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
