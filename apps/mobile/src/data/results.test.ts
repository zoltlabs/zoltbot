import { threadResults } from "@zoltbot/ui/chat/results-data";
import { waitingState } from "@zoltbot/ui/chat/waiting-state";
import { expect, it } from "vitest";
import { useChatDraft } from "../state/chat-draft";
import { comparisonVersions, revisionAvailable, versionDraft } from "./artifacts";

it("uses desktop completion and provider status rules on phone", () => {
  const e = {
    turn: [{ id: "t", threadId: "chat", status: "completed" }],
    session: [
      { id: "s", threadId: "chat", state: "ready", runtimeStatus: { state: "rate_limited" } },
    ],
  };
  expect(threadResults(e, "chat").complete).toBe(true);
  expect(waitingState(e, "chat", "online")?.label).toBe("Usage limit reached");
  expect(waitingState(e, "chat", "offline")?.kind).toBe("connection");
  for (const state of ["auth_required", "error", "reconnecting"])
    expect(
      waitingState(
        { ...e, session: [{ ...e.session[0], runtimeStatus: { state } }] },
        "chat",
        "online",
      )?.kind,
    ).toBe("provider");
  expect(
    threadResults(
      { ...e, item: [{ threadId: "chat", kind: "user", body: { queueState: "uncertain" } }] },
      "chat",
    ).complete,
  ).toBe(false);
});
it("keeps exact versions, marks unavailable versions and consumes composer handoffs once", () => {
  const options = comparisonVersions(
    {
      seq: 1,
      counters: {},
      entities: {
        artifact: [
          { id: "a", threadId: "chat", state: "active", title: "Page" },
          { id: "b", threadId: "other", state: "active" },
        ],
        artifactVersion: [
          { id: "v1", artifactId: "a", number: 1 },
          { id: "v2", artifactId: "a", number: 2, held: true },
          { id: "foreign", artifactId: "b", number: 3 },
        ],
      },
    },
    "chat",
  );
  expect(options.map((o) => [o.version.id, o.available])).toEqual([
    ["v2", false],
    ["v1", true],
  ]);
  const target = { artifactId: "a", versionId: "v1" };
  const draft = versionDraft("Page", { id: "v1", number: 1 }, "Make it clearer");
  useChatDraft.getState().prepare("chat", draft, target);
  expect(useChatDraft.getState().take("other")).toBeUndefined();
  expect(useChatDraft.getState().take("chat")).toEqual({ threadId: "chat", text: draft, target });
  expect(useChatDraft.getState().take("chat")).toBeUndefined();
});

it("only offers version drafts when this chat supports pinned artifact revisions", () => {
  const snapshot = {
    seq: 1,
    counters: {},
    entities: {
      thread: [{ id: "chat", archived: false, taskId: "" }],
      session: [{ id: "session", threadId: "chat" }],
      settings: [
        {
          key: "runtime.configuration.session",
          value: { launchManifest: { artifact: { sourceRead: 1 } } },
        },
      ],
    },
  };
  const thread = snapshot.entities.thread[0];
  if (!thread) throw Error("missing fixture thread");
  expect(revisionAvailable(snapshot, "chat")).toBe(true);
  thread.archived = true;
  expect(revisionAvailable(snapshot, "chat")).toBe(false);
  thread.archived = false;
  thread.taskId = "task";
  expect(revisionAvailable(snapshot, "chat")).toBe(false);
  thread.taskId = "";
  snapshot.entities.settings = [];
  expect(revisionAvailable(snapshot, "chat")).toBe(false);
});
