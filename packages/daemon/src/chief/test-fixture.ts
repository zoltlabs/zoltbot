import { type Command, handle, requestInteraction } from "@zoltbot/core";
import { HOST_WORKSPACE_REF, InteractionSchema, parse } from "@zoltbot/protocol";
import { at, runtimeFixture } from "../../../../tools/fakes/src/runtime-fixture.js";
import type { RuntimeContext } from "../api.js";
import { PrivateInputGuard } from "../private-input.js";
import { runtimeTools } from "../runtime-tools.js";

// Shared setup for the main agent's tests: a workspace chat that is running, and the chief's own
// thread with a running turn so its tools are authorized.

export { at };
export async function chiefFixture() {
  const f = await runtimeFixture();
  let n = 0;
  const change = (command: Command) => {
    const commandId = `change:${++n}`;
    f.store.dispatch(commandId, (state) =>
      handle(state, command, { commandId, at, actor: { kind: "system", id: "test" } }),
    );
  };
  change({
    type: "create",
    kind: "project",
    value: {
      id: "coach",
      name: "Coach V2",
      goal: "",
      instructions: "",
      constraints: "",
      roots: [],
      hierarchyDepth: 1,
      tags: [],
      requireCodeReview: false,
      skipFinalGateWhenReviewed: false,
      archived: false,
      createdAt: at,
    },
  });
  change({
    type: "create",
    kind: "thread",
    value: {
      id: "worker",
      agentId: "profile",
      projectId: "coach",
      node: { type: "project", id: "coach" },
      kind: "side",
      title: "Fix onboarding",
      titleSource: "human",
      pinned: false,
      archived: false,
      createdAt: at,
      lastActivityAt: at,
    },
  });
  change({
    type: "create",
    kind: "session",
    value: {
      id: "worker-session",
      threadId: "worker",
      provider: "reference",
      cwd: "/tmp",
      state: "starting",
      capabilities: {},
      startedAt: at,
    },
  });
  change({ type: "transition", kind: "session", id: "worker-session", to: "ready" });
  change({ type: "transition", kind: "session", id: "worker-session", to: "running" });
  change({
    type: "create",
    kind: "turn",
    value: {
      id: "worker-turn",
      sessionId: "worker-session",
      threadId: "worker",
      status: "running",
      origin: "human",
      startedAt: at,
    },
  });
  change({ type: "create", kind: "settings", value: { key: "chief.thread", value: "thread" } });
  change({ type: "transition", kind: "session", id: "session", to: "ready" });
  change({ type: "transition", kind: "session", id: "session", to: "running" });
  change({
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
  const wakes: string[] = [],
    interrupts: string[] = [],
    answered: { items: Parameters<NonNullable<RuntimeContext["answer"]>>[0]; commandId: string }[] =
      [];
  const context = {
    store: f.store,
    privacy: new PrivateInputGuard({ store: f.store, publish() {} }),
    publish() {},
    async wake(threadId: string) {
      wakes.push(threadId);
    },
    async interrupt(threadId: string, turnId: string) {
      interrupts.push(`${threadId}:${turnId}`);
    },
    answer: (async (items, commandId) => {
      answered.push({ items, commandId });
    }) as NonNullable<RuntimeContext["answer"]>,
  };
  const tools = runtimeTools(context, { waitMs: 0 });
  const actor = { agentId: "profile", threadId: "thread", sessionId: "session", turnId: "turn" };
  let calls = 0;
  const call = (name: string, args: Record<string, unknown>) => {
    const tool = tools.tools.get(name);
    if (!tool) throw new Error("missing_tool");
    return tool({ actor, arguments: args, idempotencyKey: `call:${++calls}` }) as Promise<
      Record<string, unknown>
    >;
  };
  const pending = (id: unknown) =>
    parse(
      InteractionSchema,
      f.store.snapshot(["interaction"]).interaction?.find((row) => row.id === id),
    );
  const queued = (threadId: string) =>
    (f.store.snapshot(["item"]).item ?? [])
      .filter((row) => row.threadId === threadId && row.kind === "user")
      .sort((a, b) => Number(a.seq) - Number(b.seq))
      .map((row) => {
        const body = row.body as { origin?: string; input: { text: string }[] };
        return { origin: body.origin, text: body.input[0]?.text ?? "" };
      });
  const human = { kind: "human" as const, id: "owner" };
  let requests = 0;
  /** A pending request in another chat, as a coding agent would raise it. */
  const request = (
    threadId: string,
    draft: {
      type: "approval" | "question";
      title: string;
      options?: string[];
      toolName?: string;
      createdAt?: string;
    },
  ) => {
    const id = `request-${++requests}`,
      commandId = `request:${id}`;
    f.store.dispatch(commandId, (state) =>
      requestInteraction(
        state,
        {
          id,
          agentId: "profile",
          threadId,
          type: draft.type,
          title: draft.title,
          ...(draft.toolName ? { context: { toolName: draft.toolName } } : {}),
          items: [
            draft.type === "approval"
              ? {
                  id: "action",
                  prompt: draft.title,
                  choices: [{ id: "allow_once" }, { id: "reject_once" }],
                }
              : {
                  id: "answer",
                  prompt: draft.title,
                  ...(draft.options
                    ? { options: draft.options.map((option) => ({ id: option, label: option })) }
                    : {}),
                  allowOther: !draft.options,
                },
          ],
          chain: [{ kind: "agent", id: "profile" }],
          urgency: "background",
          nativeRef: HOST_WORKSPACE_REF,
        },
        `${id}:item`,
        {
          commandId,
          at: draft.createdAt ?? new Date(Date.parse(at) + requests * 1000).toISOString(),
          actor: { kind: "agent", id: "profile" },
        },
      ),
    );
    return id;
  };
  let inputs = 0;
  /** A message in the chief's thread that has already been delivered to the agent. */
  const said = (text: string, extra: Record<string, unknown> = {}, id = `said-${++inputs}`) =>
    change({
      type: "create",
      kind: "item",
      value: {
        id,
        threadId: "thread",
        kind: "user",
        seq: 1000 + inputs,
        body: {
          queueVersion: 1,
          input: [{ type: "text", text }],
          mode: "queue",
          queueState: "sent",
          ...extra,
        },
        createdAt: at,
        updatedAt: at,
      },
    });
  let puts = 0;
  /** Test setup only: rewrite a projected row, bypassing commands that guard lifecycle fields. */
  const put = (kind: string, id: string, changes: Record<string, unknown>) =>
    f.store.dispatch(`put:${++puts}`, (state) => {
      const row = (state as Record<string, Record<string, unknown>[] | undefined>)[kind]?.find(
        (entry) => entry.id === id,
      );
      if (!row) throw new Error(`missing ${kind} ${id}`);
      return {
        events: [
          {
            eventId: `put:${puts}:0`,
            aggregateType: kind,
            aggregateId: id,
            type: `${kind}.updated`,
            occurredAt: at,
            payload: { ...row, ...changes },
          },
        ],
        result: {},
      };
    });
  const settingValue = (key: string) =>
    f.store.snapshot(["settings"]).settings?.find((row) => row.key === key)?.value;
  return {
    f,
    change,
    context,
    tools,
    actor,
    call,
    pending,
    queued,
    wakes,
    interrupts,
    answered,
    human,
    request,
    said,
    settingValue,
    put,
  };
}
