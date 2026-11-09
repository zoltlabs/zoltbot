import { handle, requestInteraction } from "@zoltbot/core";
import type { startDaemon } from "@zoltbot/daemon";
import { HOST_WORKSPACE_REF } from "@zoltbot/protocol";

// Synthetic main agent state for UI checks: Zolt's thread, a woken
// turn, and three requests it triaged as now, today and later. No model runs.

type Daemon = Awaited<ReturnType<typeof startDaemon>>;

export function seedChief(daemon: Daemon, at: string) {
  if (daemon.store.record("thread", "chief")) return;
  const actor = { kind: "system" as const, id: "fixture" };
  let n = 0;
  const create = (kind: string, value: Record<string, unknown>) => {
    const commandId = `fixture:chief:${++n}`;
    daemon.store.dispatch(commandId, (state) =>
      handle(state, { type: "create", kind, value } as never, { commandId, at, actor }),
    );
  };
  const thread = (id: string, title: string, kind: string) =>
    create("thread", {
      id,
      agentId: "p",
      kind,
      title,
      titleSource: "human",
      pinned: false,
      archived: false,
      createdAt: at,
      lastActivityAt: at,
    });
  thread("chief", "Zolt", "main");
  thread("api", "API migration", "side");
  thread("docs", "Docs refresh", "side");
  create("settings", { key: "chief.thread", value: "chief" });
  const request = (
    id: string,
    threadId: string,
    title: string,
    item: Record<string, unknown>,
    type: "approval" | "question",
  ) => {
    const commandId = `fixture:chief:request:${id}`;
    daemon.store.dispatch(commandId, (state) =>
      requestInteraction(
        state,
        {
          id,
          agentId: "p",
          threadId,
          type,
          title,
          items: [{ id: "item", prompt: title, ...item }],
          chain: [{ kind: "agent", id: "p" }],
          urgency: "blocking",
          nativeRef: HOST_WORKSPACE_REF,
        },
        `${id}:item`,
        { commandId, at, actor: { kind: "agent", id: "p" } },
      ),
    );
  };
  const allow = { choices: [{ id: "allow_once" }, { id: "reject_once" }] };
  request("deploy", "api", "Run the staging deploy script", allow, "approval");
  request(
    "branch",
    "docs",
    "Which branch should the docs go to?",
    {
      options: [
        { id: "main", label: "main" },
        { id: "release", label: "release" },
      ],
    },
    "question",
  );
  request("rename", "api", "Rename the old test helpers", allow, "approval");
  const triage = (rank: string, why: string, recommend: Record<string, unknown>) => ({
    rank,
    why,
    recommend,
    at,
    threadId: "",
    kind: "",
    title: "",
  });
  create("settings", {
    key: "chief.queue",
    value: {
      items: {
        deploy: triage("now", "Unblocks the API migration; the script only touches staging.", {
          decision: "approve",
        }),
        branch: triage("today", "Release is frozen until Monday.", {
          decision: "answer",
          choice: "main",
        }),
        rename: triage("later", "Cosmetic; nothing waits on it.", {
          decision: "decline",
          text: "Not now; after the migration.",
        }),
      },
    },
  });
  create("settings", {
    key: "chief.wake",
    value: {
      day: new Date().toLocaleDateString("en-CA"),
      used: 2,
      wasted: 0,
      results: [
        { at, useful: true },
        { at, useful: false },
      ],
    },
  });
  create("item", {
    id: "chief-wake:fixture:1",
    threadId: "chief",
    seq: 1,
    kind: "user",
    body: {
      queueVersion: 1,
      mode: "queue",
      queueState: "handled",
      input: [
        {
          type: "text",
          text: '[Zoltbot] Zolt, this is a wake-up, not a message from the user.\nNeeds you: "Run the staging deploy script" (deploy) is not triaged.\nTriage what is new with chief_triage. Never call chief_answer here.',
        },
      ],
    },
    createdAt: at,
    updatedAt: at,
  });
  create("item", {
    id: "chief-reply:1",
    threadId: "chief",
    seq: 2,
    kind: "message",
    body: { text: "Triaged three requests. The staging deploy is the one to approve now." },
    createdAt: at,
    updatedAt: at,
  });
}
