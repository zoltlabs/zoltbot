import { Value } from "@sinclair/typebox/value";
import { type ChannelRead, entitySchemas } from "@zoltbot/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  type ChannelMember,
  type ChannelRequestView,
  channelTranscript,
  currentRequest,
  groupRequests,
  insertMention,
  mentionAt,
  mentionedMembers,
  mergePosts,
  recipientLabel,
  recipientsFor,
  requestActions,
  requestMeta,
  sendingPost,
  stopConfirmation,
  toChannelView,
} from "./channels.js";
import { createClient } from "./client.js";
import { FakeTransport } from "./fake.js";
import { sampleChannelId, sampleChannelRows } from "./fake-channels.js";

const now = Date.parse("2026-11-19T12:00:00.000Z");
const members: ChannelMember[] = [
  { threadId: "mira", name: "Mira", lead: true },
  { threadId: "sam", name: "Sam", lead: false },
  { threadId: "sam-lee", name: "Sam Lee", lead: false },
  { threadId: "theo", name: "Theo", lead: false },
];
const request = (extra: Partial<ChannelRequestView>): ChannelRequestView => ({
  id: "r",
  title: "Fix it",
  state: "open",
  revision: 1,
  leadThreadId: "mira",
  leadName: "Mira",
  tasks: [],
  updatedAt: new Date(now).toISOString(),
  ...extra,
});
const task = (id: string, state: string, minutes: number) => ({
  id,
  title: `Task ${id}`,
  state,
  threadId: `thread-${id}`,
  assignee: "Sam",
  createdAt: new Date(now - minutes * 60_000).toISOString(),
  updatedAt: new Date(now - minutes * 60_000 + 60_000).toISOString(),
});

describe("routing", () => {
  it("sends to the lead unless the post @mentions members", () => {
    expect(recipientsFor("Can we fix checkout?", members).map((m) => m.name)).toEqual(["Mira"]);
    expect(recipientsFor("@Theo and @sam, any idea?", members).map((m) => m.name)).toEqual([
      "Sam",
      "Theo",
    ]);
    // The longer name wins, and an address is not a mention.
    expect(mentionedMembers("ask @Sam Lee", members)).toEqual(["sam-lee"]);
    expect(mentionedMembers("mail sam@example.com", members)).toEqual([]);
  });

  it("labels who a post reaches", () => {
    expect(recipientLabel(["Mira"])).toBe("To Mira");
    expect(recipientLabel(["Sam", "Theo"])).toBe("To Sam and Theo");
    expect(recipientLabel(["Sam", "Theo", "Mira"])).toBe("To Sam, Theo and Mira");
    expect(recipientLabel([])).toBe("");
    expect(sendingPost("p", "@Theo thanks", members, "2026-11-19T12:00:00.000Z").to).toEqual([
      "Theo",
    ]);
  });

  it("finds the mention being typed and replaces it with the member's name", () => {
    expect(mentionAt("Thanks. @T", 10)).toEqual({ query: "T", start: 8, end: 10 });
    expect(mentionAt("mail sam@ex", 11)).toBeNull();
    const theo = members[3] as ChannelMember;
    expect(insertMention("Thanks. @T", { start: 8, end: 10 }, theo)).toEqual({
      value: "Thanks. @Theo ",
      caret: 14,
    });
  });
});

describe("requests", () => {
  it("describes a request by its tasks, state or age", () => {
    const running = request({
      state: "running",
      tasks: [task("a", "running", 5), task("b", "running", 4)],
    });
    expect(requestMeta(running, now)).toBe("2 tasks running");
    expect(requestMeta(request({ tasks: [task("a", "queued", 5)] }), now)).toBe("1 task open");
    expect(requestMeta(request({}), now)).toBe("Waiting on Mira");
    expect(requestMeta(request({ state: "stopped" }), now)).toBe("Stopped");
    const yesterday = new Date(now - 26 * 3_600_000).toISOString();
    expect(requestMeta(request({ state: "done", updatedAt: yesterday }), now)).toBe("Yesterday");
  });

  it("groups requests for the sheet and offers the actions each state allows", () => {
    const rows = [
      request({ id: "1", state: "done" }),
      request({ id: "2", state: "stopped" }),
      request({ id: "3", state: "running" }),
      request({ id: "4", state: "archived" }),
    ];
    const groups = groupRequests(rows);
    expect(groups.open.map((r) => r.id)).toEqual(["3", "2"]);
    expect(groups.done.map((r) => r.id)).toEqual(["1"]);
    expect(groups.archived.map((r) => r.id)).toEqual(["4"]);
    expect(currentRequest(rows)?.id).toBe("3");
    expect(currentRequest([request({ state: "stopped" })])).toBeNull();
    expect(requestActions(rows[2] as ChannelRequestView, 3)).toEqual([
      "stop",
      "reassign",
      "archive",
    ]);
    expect(requestActions(rows[1] as ChannelRequestView, 1)).toEqual(["resume", "archive"]);
    expect(requestActions(rows[0] as ChannelRequestView, 3)).toEqual(["archive"]);
    expect(requestActions(rows[3] as ChannelRequestView, 3)).toEqual(["restore"]);
  });

  it("asks before Stop only when it cancels tasks", () => {
    expect(stopConfirmation(request({}))).toBeNull();
    expect(
      stopConfirmation(request({ tasks: [task("a", "running", 3), task("b", "completed", 9)] }))
        ?.message,
    ).toBe("This cancels 1 task.");
  });
});

describe("transcript", () => {
  it("places task events among posts in time order and keeps sending posts last", () => {
    const at = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
    const post = (id: string, minutes: number, sending = false) => ({
      id,
      author: { kind: "owner" as const },
      text: id,
      to: [],
      requestId: null,
      createdAt: at(minutes),
      ...(sending ? { sending } : {}),
    });
    const entries = channelTranscript({
      posts: [post("a", 40), post("b", 20), post("c", 30, true)],
      requests: [request({ tasks: [task("old", "running", 60), task("t", "completed", 30)] })],
    });
    expect(entries.map((e) => (e.kind === "post" ? e.post.id : e.text))).toEqual([
      "a",
      "Mira assigned Task t to Sam",
      "Task t is done",
      "b",
      "c",
    ]);
  });

  it("merges earlier pages and sending posts without repeats", () => {
    const post = (id: string) => ({
      id,
      author: { kind: "owner" as const },
      text: id,
      to: [],
      requestId: null,
      createdAt: "",
    });
    expect(
      mergePosts([post("a"), post("b")], [post("b"), post("c")], [post("c"), post("d")]).map(
        (p) => p.id,
      ),
    ).toEqual(["a", "b", "c", "d"]);
  });
});

describe("sample channel", () => {
  it("uses the real protocol entity shapes", () => {
    for (const [kind, rows] of Object.entries(sampleChannelRows(now))) {
      const schema = entitySchemas[kind as keyof typeof entitySchemas];
      expect(schema, kind).toBeDefined();
      for (const row of rows)
        expect(Value.Errors(schema, row).First(), `${kind} ${row.id}`).toBeUndefined();
    }
  });

  it("reads, pages, posts once per id and acts on requests like zoltd", async () => {
    const fake = new FakeTransport({ now: () => now });
    const client = createClient(fake);
    await vi.waitFor(() => expect(client.getState().status).toBe("online"));
    const call = client.getState().call;
    const read = (await call("channel.read", { id: sampleChannelId })) as ChannelRead;
    const view = toChannelView(client.getState().snapshot, read);
    expect(view.name).toBe("web");
    expect(view.members.map((m) => [m.name, m.lead])).toEqual([
      ["Mira", true],
      ["Sam", false],
      ["Theo", false],
    ]);
    expect(view.waiting).toEqual([
      expect.objectContaining({
        name: "Sam",
        question: "@Sam which rounding mode does Stripe use?",
      }),
    ]);
    expect(view.more).toBe(true);
    expect(requestMeta(currentRequest(view.requests) as ChannelRequestView, now)).toBe(
      "2 tasks running",
    );
    expect(
      channelTranscript(view).some(
        (e) => e.kind === "notice" && e.text === "Mira assigned Fix checkout tax rounding to Sam",
      ),
    ).toBe(true);

    const earlier = (await call("channel.read", {
      id: sampleChannelId,
      before: read.posts[0]?.id,
    })) as ChannelRead;
    expect(earlier.more).toBe(false);
    expect(earlier.posts.map((p) => p.id)).toEqual(["post-vat", "post-vat-done"]);

    const params = {
      channelId: sampleChannelId,
      id: "post-new",
      text: "@Theo thanks",
      mentions: ["thread-theo"],
    };
    const first = (await call("channel.post", params, "c1")) as { post: { recipients: string[] } };
    expect(first.post.recipients).toEqual(["thread-theo"]);
    await call("channel.post", params, "c2");
    expect(
      client.getState().snapshot.entities.channelPost?.filter((p) => p.id === "post-new"),
    ).toHaveLength(1);

    const cent = read.requests.find((r) => r.id === "request-cent");
    await expect(
      call("channel.request", {
        id: "request-cent",
        action: "stop",
        revision: cent?.revision ?? 1,
      }),
    ).rejects.toThrow(/^confirmation_required/);
    const stopped = (await call("channel.request", {
      id: "request-cent",
      action: "stop",
      revision: 1,
      confirmed: true,
    })) as { state: string; revision: number };
    expect(stopped.state).toBe("stopped");
    const tasks = client
      .getState()
      .snapshot.entities.task?.filter((t) => t.requestId === "request-cent");
    expect(tasks?.map((t) => t.state)).toEqual(["cancelled", "cancelled"]);
    await expect(
      call("channel.request", { id: "request-cent", action: "resume", revision: 1 }),
    ).rejects.toThrow(/^stale_revision/);
    const moved = (await call("channel.request", {
      id: "request-cent",
      action: "reassign",
      revision: 2,
      leadThreadId: "thread-sam",
    })) as { leadThreadId: string };
    expect(moved.leadThreadId).toBe("thread-sam");
    const archived = (await call("channel.request", {
      id: "request-cent",
      action: "archive",
      revision: 3,
    })) as { state: string };
    expect(archived.state).toBe("archived");
    const restored = (await call("channel.request", {
      id: "request-cent",
      action: "restore",
      revision: 4,
    })) as { state: string };
    expect(restored.state).toBe("stopped");
    client.stop();
  });
});
