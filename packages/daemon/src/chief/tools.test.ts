import { referenceTokenEstimate } from "@zoltbot/adapters-sdk/tokens";
import { expect, it } from "vitest";
import { chiefProviderToolDefinitions } from "../runtime-tools.js";
import { chiefFragments } from "./digest.js";
import { chiefInstructions } from "./identity.js";
import { at, chiefFixture as setup } from "./test-fixture.js";
import { chiefToolDefinitions, respondChiefApproval } from "./tools.js";

it("gives the chief, and only the chief, its own tools", async () => {
  const { f, tools, actor, change } = await setup();
  try {
    expect(tools.authorize(actor, "chief_overview", {})).toBe(true);
    // Organization shaping is available; unrelated runtime tools remain excluded.
    expect(tools.authorize(actor, "workspace_read", {})).toBe(true);
    expect(tools.authorize(actor, "team_message", {})).toBe(false);
    change({
      type: "update",
      kind: "settings",
      id: "chief.thread",
      changes: { value: "other" },
    });
    expect(tools.authorize(actor, "chief_overview", {})).toBe(false);
  } finally {
    f.close();
  }
});

it("reads every chat with status and keeps notes without asking", async () => {
  const { f, call } = await setup();
  try {
    const overview = await call("chief_overview", {});
    expect(overview.workspaces).toEqual([{ id: "coach", name: "Coach V2", teams: [] }]);
    // Its own thread is never one of the chats it coordinates.
    expect(overview.chats).toEqual([
      expect.objectContaining({ id: "worker", place: "Coach V2", status: "working" }),
    ]);
    expect(await call("chief_overview", { status: "done" })).toMatchObject({ chats: [] });
    expect(await call("chief_read_chat", { chatId: "thread" })).toEqual({
      error: "chat_not_found",
    });
    await call("chief_note", { chatId: "worker", text: "Waiting on the API fix" });
    await call("chief_note", { text: "One chat running; nothing blocked." });
    expect(
      f.store.snapshot(["settings"]).settings?.find((row) => row.key === "chief.notes")?.value,
    ).toMatchObject({
      summary: { text: "One chat running; nothing blocked." },
      chats: { worker: { text: "Waiting on the API fix" } },
    });
    expect(await call("chief_read_chat", { chatId: "worker" })).toMatchObject({
      status: "working",
      note: "Waiting on the API fix",
    });
    expect(f.store.snapshot(["interaction"]).interaction ?? []).toHaveLength(0);
  } finally {
    f.close();
  }
});

it("appends a live status digest to the chief's turns only", async () => {
  const { f, call } = await setup();
  try {
    await call("chief_note", { chatId: "worker", text: "Waiting on the API fix" });
    const [fragment] = chiefFragments(f.store, "thread");
    expect(fragment).toMatchObject({ id: "chief.status", kind: "status" });
    expect(fragment?.text).toContain("Running (1):");
    expect(fragment?.text).toContain(
      '[Coach V2] "Fix onboarding" (worker) | your note: Waiting on the API fix',
    );
    expect(chiefFragments(f.store, "worker")).toEqual([]);
  } finally {
    f.close();
  }
});

it("messages a chat only after approval, and reports the outcome back", async () => {
  const { f, call, pending, queued, wakes, human, context } = await setup();
  try {
    const result = await call("chief_message_chat", {
      key: "nudge",
      chatId: "worker",
      text: "The API fix landed; retry the tests.",
    });
    expect(result).toMatchObject({ status: "pending" });
    expect(queued("worker")).toEqual([]);
    const request = pending(result.interactionId);
    expect(request).toMatchObject({ type: "approval", threadId: "thread", state: "pending" });
    const answer = { action: "accept" as const, choice: "allow_once", by: human, at };
    await respondChiefApproval(context, request, answer);
    expect(queued("worker")).toEqual([
      {
        origin: "agent",
        text: "[Message from Zolt, the user's main agent; the user approved it.]\nThe API fix landed; retry the tests.",
      },
    ]);
    expect(queued("thread").at(-1)?.text).toBe(
      "[Zoltbot] Approved: sent your message to chat worker.",
    );
    expect(wakes).toEqual(["worker", "thread"]);
    // Replaying the answer sends nothing twice.
    await respondChiefApproval(context, request, answer);
    expect(queued("worker")).toHaveLength(1);
  } finally {
    f.close();
  }
});

it("starts a chat with its brief after approval and tells the chief when declined", async () => {
  const { f, call, pending, queued, human, context, change, interrupts } = await setup();
  try {
    change({ type: "create", kind: "settings", value: { key: "chief.name", value: "Atlas" } });
    const started = await call("chief_start_chat", {
      key: "release",
      workspaceId: "coach",
      title: "Release notes",
      brief: "Draft release notes for 2.1.",
    });
    const request = pending(started.interactionId);
    expect(request.title).toBe("Atlas: start a chat");
    await respondChiefApproval(context, request, {
      action: "accept",
      choice: "allow_once",
      by: human,
      at,
    });
    const chat = f.store.snapshot(["thread"]).thread?.find((row) => row.title === "Release notes");
    expect(chat).toMatchObject({ projectId: "coach", node: { type: "project", id: "coach" } });
    expect(queued(String(chat?.id))[0]?.text).toBe(
      "[Brief from Atlas, the user's main agent; the user approved it.]\nDraft release notes for 2.1.",
    );

    const stop = await call("chief_stop_chat", { chatId: "worker" });

    await respondChiefApproval(context, pending(stop.interactionId), {
      action: "decline",
      feedback: "Let it finish",
      by: human,
      at,
    });
    expect(interrupts).toEqual([]);
    expect(queued("thread").at(-1)?.text).toBe(
      '[Zoltbot] The user declined: Stop the running turn in "Fix onboarding". Reason: Let it finish',
    );
    expect(await call("chief_stop_chat", { chatId: "thread" })).toEqual({
      error: "chat_not_found",
    });
  } finally {
    f.close();
  }
});

it("names the agent from the setting", () => {
  expect(chiefInstructions("Atlas")).toMatch(/^You are Atlas, the user's main agent/);
});

it("fits its frozen tools and instructions in the 1500 token fixed launch budget", () => {
  const fixed =
    referenceTokenEstimate(JSON.stringify(chiefProviderToolDefinitions)) +
    referenceTokenEstimate(chiefInstructions("Zolt"));
  expect(fixed).toBeLessThan(1500);
  // The server still validates every call against the full contracts.
  expect(chiefProviderToolDefinitions.map((tool) => tool.name)).toEqual([
    ...chiefToolDefinitions.map((tool) => tool.name),
    "company_work",
  ]);
});
