import { Value } from "@sinclair/typebox/value";
import { entitySchemas } from "@zoltbot/protocol";
import { describe, expect, it, vi } from "vitest";
import { createClient } from "./client.js";
import { FakeTransport } from "./fake.js";
import { newProject } from "./projects.js";
import { sampleSnapshot } from "./sample.js";
import { deriveTaskTitle, place } from "./view.js";

describe("sample data", () => {
  it("uses the real protocol entity shapes", () => {
    const { entities } = sampleSnapshot(Date.parse("2026-11-03T12:00:00.000Z"));
    for (const [kind, rows] of Object.entries(entities)) {
      const schema = entitySchemas[kind as keyof typeof entitySchemas];
      expect(schema, kind).toBeDefined();
      for (const row of rows)
        expect(Value.Errors(schema, row).First(), `${kind} ${row.id}`).toBeUndefined();
    }
  });
});

describe("client over the fake transport", () => {
  it("loads the snapshot and applies the events a call causes", async () => {
    const fake = new FakeTransport({ replyDelayMs: 1 });
    const client = createClient(fake);
    await vi.waitFor(() => expect(client.getState().status).toBe("online"));
    expect(client.getState().snapshot.counters.pendingInteractions).toBe(3);

    await client.getState().call("interaction.answer", {
      id: "approve-tests",
      version: 1,
      answer: {
        action: "accept",
        choice: "allow_once",
        by: { kind: "human", id: "human" },
        at: new Date().toISOString(),
      },
    });
    expect(client.getState().snapshot.counters.pendingInteractions).toBe(2);
    await expect(
      client.getState().call("interaction.answer", {
        id: "approve-tests",
        version: 1,
        answer: {
          action: "cancel",
          by: { kind: "human", id: "human" },
          at: new Date().toISOString(),
        },
      }),
    ).rejects.toThrow("interaction_conflict");
    await expect(
      client.getState().call("session.setMode", { id: "session-meal", mode: "acceptEdits" }),
    ).rejects.toThrow(/^mac_only/);
    await client.getState().call("session.setMode", { id: "session-meal", mode: "plan" });
    expect(
      client.getState().snapshot.entities.session?.find((row) => row.id === "session-meal")?.mode,
    ).toBe("plan");

    await client.getState().call("turn.send", {
      threadId: "thread-unit-settings",
      input: [{ type: "text", text: "Thanks" }],
      mode: "queue",
    });
    await vi.waitFor(() => {
      const reply = client
        .getState()
        .snapshot.entities.item?.find((i) => String(i.id).endsWith("-reply"));
      expect((reply?.body as { streaming?: boolean } | undefined)?.streaming).toBeUndefined();
    });
    client.stop();
  });

  it("queues input during a turn, steers where the agent allows it and takes queued input back", async () => {
    const client = createClient(new FakeTransport({ replyDelayMs: 1 }));
    await vi.waitFor(() => expect(client.getState().status).toBe("online"));
    const say = (text: string, mode: "steer" | "queue") =>
      client.getState().call("turn.send", {
        threadId: "thread-meal-search",
        input: [{ type: "text", text }],
        mode,
      }) as Promise<{ id: string; disposition: string }>;
    const body = (id: string) =>
      client.getState().snapshot.entities.item?.find((row) => row.id === id)?.body as
        | Record<string, unknown>
        | undefined;
    const steered = await say("Use the search index", "steer");
    expect(steered.disposition).toBe("queued");
    await vi.waitFor(() =>
      expect(body(steered.id)).toMatchObject({ queueState: "sent", deliveryMode: "steer" }),
    );
    const waiting = await say("Then update the docs", "queue");
    expect(body(waiting.id)).toMatchObject({ queueState: "queued" });
    await client
      .getState()
      .call("turn.cancelQueued", { threadId: "thread-meal-search", id: waiting.id });
    expect(body(waiting.id)).toMatchObject({ queueState: "failed", errorCode: "cancelled" });
    await expect(
      client
        .getState()
        .call("turn.cancelQueued", { threadId: "thread-meal-search", id: waiting.id }),
    ).rejects.toThrow("queued_input_not_found");
    client.stop();
  });

  it("changes the model only after the cache warning, and edits by forking", async () => {
    const client = createClient(new FakeTransport({ replyDelayMs: 1 }));
    await vi.waitFor(() => expect(client.getState().status).toBe("online"));
    const call = client.getState().call;
    await expect(
      call("session.setModel", {
        id: "session-meal",
        model: "sonnet",
        cacheWarningAccepted: false,
      }),
    ).rejects.toThrow("cache_warning_required");
    await expect(
      call("session.setEffort", { id: "session-meal", effort: "huge", cacheWarningAccepted: true }),
    ).rejects.toThrow("unsupported_effort");
    await call("session.setEffort", {
      id: "session-meal",
      effort: "high",
      cacheWarningAccepted: true,
    });
    expect(
      client.getState().snapshot.entities.session?.find((row) => row.id === "session-meal"),
    ).toMatchObject({ model: "opus", effort: "high" });

    const boundary = { kind: "before_user", turnId: "turn-meal" };
    expect(await call("thread.forkPreview", { id: "thread-meal-search", boundary })).toMatchObject({
      available: false,
      reason: "fork_requires_idle",
      destinations: [{ id: "checker", name: "Checker" }],
    });
    expect(
      await call("session.rewind", {
        id: "session-meal",
        turnId: "turn-meal",
        dryRun: true,
        confirmed: false,
      }),
    ).toMatchObject({ canRewind: true, files: ["src/meals/search.ts"] });
    const fork = (await call(
      "thread.fork",
      { id: "thread-meal-search", kind: "copied", boundary, title: "Meal search · edited" },
      "edit-1:fork",
    )) as { childThreadId: string; state: string };
    expect(fork.state).toBe("ready");
    // The child inherits the earlier messages as history, not as its own items.
    expect(await call("thread.forkHistory", { id: fork.childThreadId })).toEqual({ items: [] });
    expect(
      client.getState().snapshot.entities.item?.some((row) => row.threadId === fork.childThreadId),
    ).toBe(false);
    expect(
      client.getState().snapshot.entities.thread?.find((row) => row.id === fork.childThreadId),
    ).toMatchObject({
      title: "Meal search · edited",
      fork: { sourceThreadId: "thread-meal-search" },
    });
    client.stop();
  });

  it("answers the Inbox's thread methods the way zoltd does", async () => {
    const client = createClient(new FakeTransport({ replyDelayMs: 1 }));
    await vi.waitFor(() => expect(client.getState().status).toBe("online"));
    const call = client.getState().call;
    const thread = (id: string) =>
      client.getState().snapshot.entities.thread?.find((row) => row.id === id);
    await call("thread.markRead", { id: "thread-unit-settings", at: "2026-11-03T12:00:00.000Z" });
    await call("thread.markRead", { id: "thread-unit-settings", at: "2026-11-01T00:00:00.000Z" });
    expect(thread("thread-unit-settings")?.lastReadAt).toBe("2026-11-03T12:00:00.000Z");
    await call("thread.markUnread", { id: "thread-unit-settings" });
    // Unread again: read up to just before its last turn ended.
    const ended = client
      .getState()
      .snapshot.entities.turn?.find((row) => row.id === "turn-units")?.endedAt;
    expect(Date.parse(String(thread("thread-unit-settings")?.lastReadAt))).toBe(
      Date.parse(String(ended)) - 1,
    );
    await call("thread.snooze", { id: "thread-unit-settings", until: "2026-11-09T09:00:00.000Z" });
    expect(thread("thread-unit-settings")?.snoozedUntil).toBe("2026-11-09T09:00:00.000Z");
    await call("thread.snooze", { id: "thread-unit-settings", until: null });
    expect(thread("thread-unit-settings")?.snoozedUntil).toBeUndefined();
    // A quiet chat archives at once; a working one waits until it goes quiet.
    expect(await call("thread.settle", { id: "thread-dark-mode" })).toMatchObject({
      archived: true,
    });
    expect(await call("thread.settle", { id: "thread-meal-search" })).toMatchObject({
      archived: false,
      thread: { archiveWhenIdle: true },
    });
    await call("thread.unarchive", { id: "thread-dark-mode" });
    expect(thread("thread-dark-mode")?.archived).toBe(false);
    const reply = (await call("thread.reply", {
      threadId: "thread-archived",
      body: "Leave them out",
      answers: [
        {
          interactionId: "archived-question",
          version: 1,
          answers: { archived: { options: ["no"] } },
        },
      ],
    })) as { resolved: string[] };
    expect(reply.resolved).toEqual(["archived-question"]);
    expect(
      client.getState().snapshot.entities.interaction?.find((row) => row.id === "archived-question")
        ?.state,
    ).not.toBe("pending");
    client.stop();
  });

  it("refuses wrong params the way zoltd would", async () => {
    const client = createClient(new FakeTransport());
    await vi.waitFor(() => expect(client.getState().status).toBe("online"));
    await expect(client.getState().call("task.cancel", { id: "meal-search" })).rejects.toThrow(
      "Bad params",
    );
    client.stop();
  });

  it("keeps saved data and blocks actions while the Mac is offline", async () => {
    const fake = new FakeTransport();
    const client = createClient(fake);
    await vi.waitFor(() => expect(client.getState().status).toBe("online"));
    fake.setMacOnline(false);
    expect(client.getState().status).toBe("mac_offline");
    expect(client.getState().lastSeenAt).toBeDefined();
    expect(client.getState().snapshot.entities.task?.length).toBe(5);
    await expect(client.getState().call("task.retry", { id: "dark-mode" })).rejects.toThrow(
      "offline",
    );
    fake.setMacOnline(true);
    await vi.waitFor(() => expect(client.getState().status).toBe("online"));
    client.stop();
  });

  it("creates tasks and chats directly in a teamless project root", async () => {
    const client = createClient(new FakeTransport());
    await vi.waitFor(() => expect(client.getState().status).toBe("online"));
    const call = client.getState().call;
    const at = new Date().toISOString();
    await call("project.create", {
      value: newProject("solo", "Solo app", "/Users/you/Projects/solo-app", at),
    });
    const brief = "Fix the empty-state spacing on iPhone SE\n\nCheck both light and dark themes.";
    const created = (await call("task.create", {
      title: deriveTaskTitle(brief),
      brief,
      profileId: "builder",
      node: { type: "project", id: "solo" },
    })) as Record<string, unknown>;
    expect(created).toMatchObject({
      projectId: "solo",
      node: { type: "project", id: "solo" },
      title: "Fix the empty-state spacing on iPhone SE",
      ownerAgentId: "builder",
    });
    expect(place(client.getState().snapshot, created)).toBe("Solo app");

    await call("thread.create", {
      value: {
        id: "thread-solo-chat",
        agentId: "checker",
        projectId: "solo",
        node: { type: "project", id: "solo" },
        kind: "side",
        title: "Audit API error codes",
        titleSource: "auto",
        pinned: false,
        archived: false,
        createdAt: at,
        lastActivityAt: at,
      },
    });
    for (const [kind, rows] of Object.entries(client.getState().snapshot.entities)) {
      const schema = entitySchemas[kind as keyof typeof entitySchemas];
      for (const row of rows)
        expect(Value.Errors(schema, row).First(), `${kind} ${row.id}`).toBeUndefined();
    }
    client.stop();
  });
});
