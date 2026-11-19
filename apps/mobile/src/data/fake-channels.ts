import type { FakeRows } from "./fake-manage.js";
import type { Row } from "./transport.js";

// The sample Mac's team channel: project "Acme web", channel #web led by Mira with Sam and Theo.
// Rows live in the snapshot, so posts and request changes arrive as ordinary entity events.

export const sampleChannelId = "channel-acme-web";
const projectId = "acme-web";
const mira = "thread-mira";
const sam = "thread-sam";
const theo = "thread-theo";
const ada = "thread-ada";
const teamId = "team-web";
const members = [mira, sam, theo];
/** Smaller than zoltd's 200, so the sample shows Show earlier. */
const samplePage = 6;

/** Rows for the sample channel, in the real entity shapes. Times are relative to `now`. */
export function sampleChannelRows(now: number): Record<string, Row[]> {
  const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  const agent = (id: string, name: string): Row => ({
    id,
    name,
    avatar: name.slice(0, 1),
    kind: "profile",
    definitionId: "claude",
    permissionProfile: "workspace_write",
    instructions: "",
    hidden: false,
    archived: false,
    createdAt: ago(60 * 24 * 20),
  });
  const thread = (id: string, agentId: string, title: string, kind: string, taskId?: string) => ({
    id,
    agentId,
    projectId,
    node: id === ada ? { type: "project", id: projectId } : { type: "subproject", id: teamId },
    ...(taskId ? { taskId } : {}),
    kind,
    title,
    titleSource: "human",
    pinned: false,
    archived: false,
    createdAt: ago(60 * 24 * 20),
    lastActivityAt: ago(10),
  });
  const task = (id: string, title: string, threadId: string, owner: string, minutes: number) => ({
    id,
    projectId,
    node: { type: "subproject", id: teamId },
    rootId: id,
    title,
    brief: title,
    acceptance: "",
    expectedDeliverable: "A tested change",
    ownerAgentId: owner,
    threadId,
    workspaceMode: "worktree",
    state: "running",
    revision: 1,
    attempt: 1,
    maxAttempts: 3,
    reviewRequired: true,
    executionLocation: "local",
    createdBy: { kind: "agent", id: "agent-mira" },
    requestId: "request-cent",
    createdAt: ago(minutes),
    updatedAt: ago(minutes),
  });
  const post = (
    id: string,
    minutes: number,
    author: string | null,
    body: string,
    requestId: string,
    to: string[],
    question: boolean,
  ): Row => ({
    id,
    channelId: sampleChannelId,
    projectId,
    author: author ? { kind: "thread", threadId: author } : { kind: "owner" },
    text: body,
    mentions: author && to[0] !== mira ? to : [],
    recipients: to,
    messageIds: to.map((_, index) => `${id}:to:${index}`),
    requestId,
    question,
    createdAt: ago(minutes),
  });
  const request = (
    id: string,
    title: string,
    state: string,
    minutes: number,
    updated: number,
  ): Row => ({
    id,
    channelId: sampleChannelId,
    projectId,
    postId: `post-${id.slice("request-".length)}`,
    title,
    leadThreadId: mira,
    state,
    revision: 1,
    createdAt: ago(minutes),
    updatedAt: ago(updated),
  });
  return {
    project: [
      {
        id: projectId,
        name: "Acme web",
        goal: "The Acme store website.",
        instructions: "",
        constraints: "",
        roots: [{ path: "/Users/you/Projects/acme-web", label: "Acme web" }],
        hierarchyDepth: 1,
        tags: [],
        requireCodeReview: true,
        skipFinalGateWhenReviewed: false,
        archived: false,
        createdAt: ago(60 * 24 * 30),
      },
    ],
    subproject: [
      {
        id: teamId,
        projectId,
        name: "Web",
        label: "Team",
        goal: "The store front end.",
        instructions: "",
        depth: 1,
        archived: false,
        createdAt: ago(60 * 24 * 30),
      },
    ],
    agent: [
      agent("agent-ada", "Ada"),
      agent("agent-mira", "Mira"),
      agent("agent-sam", "Sam"),
      agent("agent-theo", "Theo"),
    ],
    thread: [
      thread(ada, "agent-ada", "Ada", "manager"),
      thread(mira, "agent-mira", "Mira", "manager"),
      thread(sam, "agent-sam", "Sam", "main"),
      thread(theo, "agent-theo", "Theo", "main"),
      thread(
        "thread-task-rounding",
        "agent-sam",
        "Fix checkout tax rounding",
        "task",
        "task-rounding",
      ),
      thread("thread-task-invoice", "agent-theo", "Test invoice rounding", "task", "task-invoice"),
    ],
    task: [
      task("task-rounding", "Fix checkout tax rounding", "thread-task-rounding", "agent-sam", 35),
      task("task-invoice", "Test invoice rounding", "thread-task-invoice", "agent-theo", 29),
    ],
    channel: [
      {
        id: sampleChannelId,
        projectId,
        kind: "team",
        teamId,
        name: "web",
        leadThreadId: mira,
        memberThreadIds: members,
        createdAt: ago(60 * 24 * 20),
        updatedAt: ago(60 * 24 * 20),
      },
      {
        id: "channel-acme-all",
        projectId,
        kind: "project",
        name: "acme-web",
        leadThreadId: ada,
        memberThreadIds: [ada, ...members],
        createdAt: ago(60 * 24 * 20),
        updatedAt: ago(60 * 24 * 20),
      },
    ],
    channelRequest: [
      request("request-vat", "Add VAT number field", "done", 60 * 26, 60 * 25),
      request("request-speed", "Speed up the product page", "stopped", 60 * 5, 60 * 4),
      request("request-cent", "Checkout total is off by a cent", "running", 40, 35),
    ],
    channelPost: [
      post(
        "post-vat",
        60 * 26,
        null,
        "Add a VAT number field to checkout.",
        "request-vat",
        [mira],
        true,
      ),
      post(
        "post-vat-done",
        60 * 25,
        mira,
        "Done. The field checks the format and saves with the order.",
        "request-vat",
        [],
        false,
      ),
      post("post-speed", 60 * 5, null, "Speed up the product page.", "request-speed", [mira], true),
      post(
        "post-speed-plan",
        60 * 4.8,
        mira,
        "Images are the slow part. I'll start with lazy loading.",
        "request-speed",
        [],
        false,
      ),
      post(
        "post-cent",
        40,
        null,
        "Checkout total is off by a cent on EU orders. Can we fix it before Friday?",
        "request-cent",
        [mira],
        true,
      ),
      post(
        "post-cent-ask",
        36,
        mira,
        "On it. @Theo do invoices round the same way as checkout?",
        "request-cent",
        [theo],
        true,
      ),
      post(
        "post-cent-theo",
        30,
        theo,
        "No. Invoices round each line, checkout rounds the total. I'll add a test that covers both.",
        "request-cent",
        [mira],
        false,
      ),
      post(
        "post-cent-sam",
        10,
        mira,
        "@Sam which rounding mode does Stripe use?",
        "request-cent",
        [sam],
        true,
      ),
    ],
  };
}

const text = (value: unknown) => (typeof value === "string" ? value : "");
const byTime = (a: Row, b: Row) => text(a.createdAt).localeCompare(text(b.createdAt));

/** Puts the sample channel's rows in the snapshot the first time a channel method runs. */
function seed(store: FakeRows) {
  if (store.rows("channel").some((row) => row.id === sampleChannelId)) return;
  const rows = sampleChannelRows(Date.parse(store.at()));
  for (const [kind, list] of Object.entries(rows)) {
    for (const row of list)
      if (!store.rows(kind).some((entry) => entry.id === row.id)) store.put(kind, row, "created");
  }
}

/** Questions with no answer yet, the way zoltd works them out. */
function waiting(store: FakeRows, channel: Row) {
  const posts = store
    .rows("channelPost")
    .filter((row) => row.channelId === channel.id)
    .sort(byTime);
  const closed = new Set(
    store
      .rows("channelRequest")
      .filter((row) => ["stopped", "archived", "done"].includes(text(row.state)))
      .map((row) => row.id),
  );
  const ids = channel.memberThreadIds as string[];
  return posts.flatMap((post, index) => {
    if (!post.question || closed.has(post.requestId)) return [];
    return (post.recipients as string[])
      .filter((threadId) => ids.includes(threadId))
      .filter(
        (threadId) =>
          !posts
            .slice(index + 1)
            .some(
              (later) =>
                (later.author as Row).kind === "thread" &&
                (later.author as Row).threadId === threadId,
            ),
      )
      .map((threadId) => ({
        postId: post.id,
        threadId,
        askedBy: post.author,
        since: post.createdAt,
      }));
  });
}

/** A request title: the first line of the post, cut at a word. */
function requestTitle(body: string): string {
  const first = body.trim().split("\n")[0]?.trim() ?? "";
  if (first.length <= 80) return first || "Request";
  const cut = first.slice(0, 80);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 40 ? cut.lastIndexOf(" ") : 80).trimEnd()}…`;
}

const allowed: Record<string, string[]> = {
  stop: ["open", "running"],
  resume: ["stopped"],
  reassign: ["open", "running", "stopped"],
  archive: ["open", "running", "done", "stopped"],
  restore: ["archived"],
};
const finalTaskStates = ["completed", "failed", "cancelled"];

/** The answer to a channel call, or undefined when the method is not one. */
export function answerChannel(store: FakeRows, method: string, p: Row): unknown {
  if (!method.startsWith("channel.")) return undefined;
  seed(store);
  const now = store.at();
  switch (method) {
    case "channel.list":
      return {
        items: store
          .rows("channel")
          .filter((row) => !p.projectId || row.projectId === p.projectId)
          .sort((a, b) => text(a.name).localeCompare(text(b.name))),
      };
    case "channel.read": {
      const channel = store.find("channel", p.id);
      const all = store
        .rows("channelPost")
        .filter((row) => row.channelId === channel.id)
        .sort(byTime);
      const end = p.before ? all.findIndex((row) => row.id === p.before) : all.length;
      if (end < 0) throw new Error("not_found: channelPost");
      const start = Math.max(0, end - (typeof p.limit === "number" ? p.limit : samplePage));
      const requests = store
        .rows("channelRequest")
        .filter((row) => row.channelId === channel.id)
        .sort(byTime);
      const ids = new Set(requests.map((row) => row.id));
      return structuredClone({
        channel,
        posts: all.slice(start, end),
        requests,
        tasks: store
          .rows("task")
          .filter((task) => ids.has(task.requestId))
          .map((task) => ({
            id: task.id,
            requestId: task.requestId,
            title: task.title,
            state: task.state,
            ...(task.threadId ? { threadId: task.threadId } : {}),
            createdAt: task.createdAt,
            updatedAt: task.updatedAt,
          })),
        waiting: waiting(store, channel),
        more: start > 0,
      });
    }
    case "channel.post": {
      const channel = store.find("channel", p.channelId);
      if (channel.archivedAt) throw new Error("channel_archived");
      const existing = store.rows("channelPost").find((row) => row.id === p.id);
      if (existing) {
        if (existing.text !== p.text) throw new Error("already_exists: channelPost");
        return { post: existing, request: store.find("channelRequest", existing.requestId) };
      }
      const ids = channel.memberThreadIds as string[];
      const mentions = (p.mentions as string[] | undefined) ?? [];
      if (mentions.some((id) => !ids.includes(id))) throw new Error("mention_not_member");
      const recipients = mentions.length ? mentions : [text(channel.leadThreadId)];
      const requestId = `request-${p.id}`;
      const post = store.put(
        "channelPost",
        {
          id: p.id,
          channelId: channel.id,
          projectId: channel.projectId,
          author: { kind: "owner" },
          text: p.text,
          mentions,
          recipients,
          messageIds: recipients.map((_, index) => `${p.id}:to:${index}`),
          requestId,
          question: true,
          createdAt: now,
        },
        "created",
      );
      const request = store.put(
        "channelRequest",
        {
          id: requestId,
          channelId: channel.id,
          projectId: channel.projectId,
          postId: p.id,
          title: requestTitle(text(p.text)),
          leadThreadId: channel.leadThreadId,
          state: "open",
          revision: 1,
          createdAt: now,
          updatedAt: now,
        },
        "created",
      );
      return { post, request };
    }
    case "channel.request": {
      const request = store.find("channelRequest", p.id);
      if (request.revision !== p.revision) throw new Error("stale_revision: request changed");
      const action = text(p.action);
      if (!allowed[action]?.includes(text(request.state)))
        throw new Error(`invalid_request_action: ${action} from ${text(request.state)}`);
      const open = store
        .rows("task")
        .filter(
          (task) => task.requestId === request.id && !finalTaskStates.includes(text(task.state)),
        );
      if (action === "stop" && open.length && p.confirmed !== true)
        throw new Error("confirmation_required: stopping cancels the request's tasks");
      const channel = store.find("channel", request.channelId);
      let next: Row = { ...request, revision: Number(request.revision) + 1, updatedAt: now };
      if (action === "stop") {
        next = { ...next, state: "stopped" };
        for (const task of open) store.put("task", { ...task, state: "cancelled", updatedAt: now });
      } else if (action === "resume") next = { ...next, state: "open" };
      else if (action === "reassign") {
        const lead = text(p.leadThreadId);
        if (!(channel.memberThreadIds as string[]).includes(lead) || lead === request.leadThreadId)
          throw new Error("lead_not_member");
        next = { ...next, leadThreadId: lead };
      } else if (action === "archive")
        next = { ...next, state: "archived", archivedFrom: request.state };
      else {
        const { archivedFrom, ...rest } = next;
        next = { ...rest, state: archivedFrom ?? "open" };
      }
      return store.put("channelRequest", next);
    }
    default:
      return undefined;
  }
}
