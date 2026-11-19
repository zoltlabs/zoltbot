import { rmSync } from "node:fs";
import path from "node:path";
import { type Command, handle, readStaffAllowance } from "@zoltbot/core";
import {
  type Interaction,
  InteractionSchema,
  parse,
  STAFF_ALLOWANCE_OPTION,
  STAFF_APPROVAL_ITEM,
} from "@zoltbot/protocol";
import { openStore, type Store } from "@zoltbot/store";
import { expect, it } from "vitest";
import { at, runtimeFixture } from "../../../tools/fakes/src/runtime-fixture.js";
import { PrivateInputGuard } from "./private-input.js";
import { runtimeTools } from "./runtime-tools.js";
import { requestStaffChange, respondStaffApproval, staffApi } from "./staff-tools.js";

/** A Payments manager ("thread") with Mira and Theo, and a Sales chat outside its team. */
async function payments() {
  const f = await runtimeFixture();
  let n = 0;
  const change = (store: Store, command: Command) => {
    const commandId = `change:${++n}`;
    store.dispatch(commandId, (state) =>
      handle(state, command, { commandId, at, actor: { kind: "system", id: "test" } }),
    );
  };
  change(f.store, {
    type: "create",
    kind: "project",
    value: {
      id: "co",
      name: "Company",
      goal: "",
      instructions: "",
      constraints: "",
      roots: [],
      hierarchyDepth: 3,
      tags: [],
      requireCodeReview: false,
      skipFinalGateWhenReviewed: false,
      archived: false,
      createdAt: at,
    },
  });
  for (const id of ["pay", "sales"])
    change(f.store, {
      type: "create",
      kind: "subproject",
      value: {
        id,
        projectId: "co",
        name: id === "pay" ? "Payments" : "Sales",
        label: "Team",
        goal: "",
        instructions: "",
        depth: 1,
        archived: false,
        createdAt: at,
      },
    });
  change(f.store, {
    type: "update",
    kind: "thread",
    id: "thread",
    changes: {
      kind: "manager",
      title: "Payments",
      projectId: "co",
      node: { type: "subproject", id: "pay" },
    },
  });
  for (const [id, team] of [
    ["mira", "pay"],
    ["theo", "pay"],
    ["sales-chat", "sales"],
  ] as const)
    change(f.store, {
      type: "create",
      kind: "thread",
      value: {
        id,
        agentId: "profile",
        projectId: "co",
        node: { type: "subproject", id: team },
        kind: "side",
        title: id === "mira" ? "Mira" : id === "theo" ? "Theo" : "Sales chat",
        titleSource: "human",
        pinned: false,
        archived: false,
        createdAt: at,
        lastActivityAt: at,
      },
    });
  change(f.store, { type: "transition", kind: "session", id: "session", to: "ready" });
  change(f.store, { type: "transition", kind: "session", id: "session", to: "running" });
  change(f.store, {
    type: "create",
    kind: "turn",
    value: {
      id: "turn",
      sessionId: "session",
      threadId: "thread",
      status: "running",
      origin: "human",
      startedAt: at,
    },
  });
  return { f, change };
}
function contextFor(store: Store, woken: string[] = []) {
  return {
    store,
    privacy: new PrivateInputGuard({ store, publish() {} }),
    publish() {},
    async wake(id: string) {
      woken.push(id);
    },
  };
}
const manager = { agentId: "profile", threadId: "thread", sessionId: "session", turnId: "turn" };
const work = (store: Store, args: Record<string, unknown>) => {
  const tool = runtimeTools(contextFor(store), { waitMs: 0 }).tools.get("company_work");
  if (!tool) throw new Error("missing_company_work");
  return tool({ actor: manager, arguments: args, idempotencyKey: String(args.key) }) as Promise<
    Record<string, unknown>
  >;
};
const interaction = (store: Store, id: unknown): Interaction =>
  parse(
    InteractionSchema,
    store.snapshot(["interaction"]).interaction?.find((row) => row.id === id),
  );
const owner = (allowance = false, accept = true) => ({
  action: accept ? ("accept" as const) : ("decline" as const),
  ...(accept ? { choice: "allow_once" } : {}),
  ...(allowance
    ? { answers: { [STAFF_APPROVAL_ITEM]: { options: [STAFF_ALLOWANCE_OPTION] } } }
    : {}),
  by: { kind: "human" as const, id: "local-owner" },
  at,
});
const queuedText = (store: Store, threadId: string) =>
  (store.snapshot(["item"]).item ?? [])
    .filter((row) => row.threadId === threadId && row.kind === "user")
    .map((row) => JSON.stringify(row.body))
    .join("\n");
const hire = {
  kind: "add",
  name: "Quinn",
  role: "QA for refunds",
  folders: ["tests/payments"],
  firstTask: { title: "Refund tests", brief: "Cover full and partial refunds." },
};

it("asks the owner with one card, applies on approval and then hires within the allowance", async () => {
  const { f } = await payments();
  try {
    const asked = await work(f.store, { action: "staff", key: "quinn", request: hire });
    expect(asked).toMatchObject({ status: "pending", reasons: ["new_employee"] });
    const card = interaction(f.store, asked.interactionId);
    expect(card).toMatchObject({ type: "approval", title: "Add Quinn to Payments" });
    const stored = (card.context?.toolInput as { staffChange: { preview: unknown } }).staffChange;
    expect(stored.preview).toMatchObject({
      kind: "add",
      fields: expect.arrayContaining([{ label: "Can edit", after: "tests/payments" }]),
      allowanceOffer: { max: 2, folders: ["tests/payments"] },
    });
    // The same key returns the same card instead of asking twice.
    expect(await work(f.store, { action: "staff", key: "quinn", request: hire })).toEqual(asked);
    expect(f.store.snapshot(["thread"]).thread?.some((r) => r.title === "Quinn")).toBe(false);

    const woken: string[] = [];
    await respondStaffApproval(contextFor(f.store, woken), card, owner(true));
    const state = f.store.snapshot(["thread", "task", "settings", "audit"]);
    const quinn = state.thread?.find((r) => r.title === "Quinn");
    expect(quinn).toMatchObject({ kind: "side", node: { type: "subproject", id: "pay" } });
    expect(state.task?.find((r) => r.threadId === quinn?.id)).toMatchObject({
      title: "Refund tests",
      accountableThreadId: "thread",
    });
    expect(readStaffAllowance(state, "thread")).toMatchObject({ max: 2, used: 0 });
    expect(queuedText(f.store, "thread")).toContain("Approved: added Quinn to Payments");
    expect(woken).toEqual(["thread"]);
    expect(state.audit?.find((r) => r.action === "staff.add")?.detail).toMatchObject({
      confirmed: true,
      interactionId: card.id,
    });

    // Within the allowance the next hire runs at once; outside the folders it asks again.
    const next = await work(f.store, {
      action: "staff",
      key: "rae",
      request: { ...hire, name: "Rae", firstTask: undefined },
    });
    expect(next).toMatchObject({ status: "done", allowance: true });
    expect(readStaffAllowance(f.store.snapshot(["settings"]), "thread")?.used).toBe(1);
    const outside = await work(f.store, {
      action: "staff",
      key: "sam",
      request: { ...hire, name: "Sam", folders: ["src"], firstTask: undefined },
    });
    expect(outside).toMatchObject({ status: "pending" });
  } finally {
    f.close();
  }
});

it("declines without changes and refuses requests outside the manager's team", async () => {
  const { f } = await payments();
  try {
    const asked = await work(f.store, {
      action: "staff",
      key: "change-theo",
      request: { kind: "change", threadId: "theo", model: "opus", instructions: "Own the API." },
    });
    const card = interaction(f.store, asked.interactionId);
    expect(card.title).toBe("Change Theo");
    await respondStaffApproval(contextFor(f.store), card, {
      ...owner(false, false),
      feedback: "Not yet",
    });
    expect(queuedText(f.store, "thread")).toContain(
      "The owner declined: Change Theo. Reason: Not yet",
    );
    expect(f.store.record("agent", "profile")?.model).toBeUndefined();
    await expect(
      work(f.store, {
        action: "staff",
        key: "sales",
        request: { kind: "archive", threadId: "sales-chat" },
      }),
    ).rejects.toThrow("staff_outside_scope");
    await expect(
      requestStaffChange(contextFor(f.store), { ...manager, threadId: "mira" }, hire, "k"),
    ).rejects.toThrow("staff_scope_required");
    // An agent's answer is never the owner's approval.
    const archive = await work(f.store, {
      action: "staff",
      key: "archive-mira",
      request: { kind: "archive", threadId: "mira" },
    });
    await expect(
      respondStaffApproval(contextFor(f.store), interaction(f.store, archive.interactionId), {
        ...owner(),
        by: { kind: "agent", id: "profile" },
      }),
    ).rejects.toThrow("human_answer_required");
  } finally {
    f.close();
  }
});

it("archives across a restart: queued work moves, running work finishes first", async () => {
  const { f, change } = await payments();
  const dbPath = path.join(f.root, "store.db");
  let store = f.store;
  try {
    const task = (id: string, threadId: string) =>
      change(store, {
        type: "create",
        kind: "task",
        value: {
          id,
          projectId: "co",
          node: { type: "subproject", id: "pay" },
          rootId: id,
          title: id === "q" ? "Webhook load test" : "Refund endpoint",
          brief: "Do it",
          acceptance: "",
          expectedDeliverable: "",
          ownerAgentId: "profile",
          threadId,
          dependencies: [],
          planned: false,
          workspaceMode: "shared",
          state: "queued",
          revision: 1,
          attempt: 1,
          maxAttempts: 1,
          reviewRequired: true,
          executionLocation: "local_host",
          createdBy: { kind: "human", id: "owner" },
          createdAt: at,
          updatedAt: at,
        },
      });
    task("q", "theo");
    const asked = await work(store, {
      action: "staff",
      key: "archive-theo",
      request: { kind: "archive", threadId: "theo", moveTo: "mira" },
    });
    const preview = (
      interaction(store, asked.interactionId).context?.toolInput as {
        staffChange: { preview: { moves: unknown } };
      }
    ).staffChange.preview;
    expect(preview.moves).toEqual([{ taskId: "q", title: "Webhook load test", to: "Mira" }]);

    // The pending card survives a restart and still applies.
    store.close();
    store = await openStore(dbPath);
    await respondStaffApproval(contextFor(store), interaction(store, asked.interactionId), owner());
    expect(store.record("task", "q")).toMatchObject({ threadId: "mira", state: "queued" });
    expect(store.record("thread", "theo")).toMatchObject({ archived: true });
    expect(queuedText(store, "mira")).toContain("Theo was archived");

    // The owner archives Mira while her turn runs: she finishes first, then the chat archives.
    change(store, {
      type: "create",
      kind: "session",
      value: {
        id: "s-mira",
        threadId: "mira",
        provider: "reference",
        cwd: f.root,
        state: "starting",
        capabilities: {},
        startedAt: at,
      },
    });
    change(store, { type: "transition", kind: "session", id: "s-mira", to: "ready" });
    change(store, { type: "transition", kind: "session", id: "s-mira", to: "running" });
    change(store, {
      type: "create",
      kind: "turn",
      value: {
        id: "t-mira",
        sessionId: "s-mira",
        threadId: "mira",
        status: "running",
        origin: "human",
        startedAt: at,
      },
    });
    const api = staffApi(contextFor(store));
    const result = await api(
      "staff.apply",
      { request: { kind: "archive", threadId: "mira" } },
      "owner:archive-mira",
    );
    expect(result).toMatchObject({ archived: false, moved: ["q"] });
    expect(store.record("thread", "mira")).toMatchObject({
      archived: false,
      archiveWhenIdle: true,
    });
    expect(store.record("task", "q")).toMatchObject({ threadId: "thread" });
    store.close();
    store = await openStore(dbPath);
    expect(store.record("thread", "mira")?.archiveWhenIdle).toBe(true);
    // A retried click replays the same receipt.
    expect(
      await staffApi(contextFor(store))(
        "staff.apply",
        { request: { kind: "archive", threadId: "mira" } },
        "owner:archive-mira",
      ),
    ).toEqual(result);
  } finally {
    store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

it("lets the owner set and clear a manager's allowance", async () => {
  const { f } = await payments();
  try {
    const api = staffApi(contextFor(f.store));
    await api("staff.allowance", { threadId: "thread", max: 3, models: ["sonnet"] }, "set");
    expect(readStaffAllowance(f.store.snapshot(["settings"]), "thread")).toMatchObject({
      max: 3,
      models: ["sonnet"],
      folders: [],
    });
    await api("staff.allowance", { threadId: "thread", max: 0 }, "clear");
    expect(readStaffAllowance(f.store.snapshot(["settings"]), "thread")?.max).toBe(0);
    await expect(api("staff.allowance", { threadId: "mira", max: 1 }, "x")).rejects.toThrow(
      "manager_unavailable",
    );
    await expect(api("staff.apply", { request: { kind: "fire" } }, "y")).rejects.toThrow();
    expect(await api("unknown.method", {}, "z")).toBeUndefined();
  } finally {
    f.close();
  }
});
