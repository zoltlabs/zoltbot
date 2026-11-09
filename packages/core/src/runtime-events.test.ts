import { expect, it } from "vitest";
import { applyEvents } from "./projectors.js";
import { observeRuntimeEvent } from "./runtime-events.js";

const at = "2026-10-28T12:00:00Z";
const context = { commandId: "runtime", at, actor: { kind: "system" as const, id: "runtime" } };
const base = {
  thread: [{ id: "thread", agentId: "profile" }],
  session: [
    {
      id: "session",
      threadId: "thread",
      provider: "reference",
      cwd: "/work/repo",
      state: "starting",
      capabilities: {},
      startedAt: at,
    },
  ],
};
const input = { sessionId: "session", threadId: "thread" };
const started = () =>
  applyEvents(
    base,
    observeRuntimeEvent(base, { ...input, event: { t: "turn.started", turnId: "turn" } }, context)
      .events,
  );
it("starts one owned turn and fences a competing turn without changing cwd", () => {
  const state = started();
  expect(state.turn?.[0]).toMatchObject({ id: "turn", sessionId: "session", status: "running" });
  expect(state.session?.[0]).toMatchObject({ state: "running", cwd: "/work/repo" });
  expect(() =>
    observeRuntimeEvent(
      state,
      { ...input, event: { t: "turn.started", turnId: "other" } },
      context,
    ),
  ).toThrow("runtime_turn_already_running");
  expect(() =>
    observeRuntimeEvent(
      state,
      { ...input, threadId: "other", event: { t: "turn.started", turnId: "other" } },
      context,
    ),
  ).toThrow("runtime_session_mismatch");
});
it("keeps deltas transient and persists the authoritative completed message once", () => {
  const state = started();
  expect(
    observeRuntimeEvent(
      state,
      {
        ...input,
        itemId: "message",
        event: { t: "text.delta", turnId: "turn", itemId: "native", text: "partial" },
      },
      context,
    ),
  ).toMatchObject({ events: [], result: { transient: true } });
  const event = {
    t: "message.done" as const,
    turnId: "turn",
    itemId: "native",
    text: "Complete text",
    phase: "final" as const,
  };
  const next = applyEvents(
    state,
    observeRuntimeEvent(state, { ...input, itemId: "message", event }, context).events,
  );
  expect(next.item?.[0]).toMatchObject({
    id: "message",
    turnId: "turn",
    kind: "message",
    phase: "final",
    body: { text: "Complete text", nativeItemId: "native" },
  });
  const repeated = applyEvents(
    next,
    observeRuntimeEvent(next, { ...input, itemId: "message", event }, context).events,
  );
  expect(repeated.item).toHaveLength(1);
});
it("retains tool identity and input through updates and completion", () => {
  let state = started();
  for (const event of [
    {
      t: "tool.started",
      turnId: "turn",
      itemId: "native",
      name: "read",
      kind: "read",
      input: { path: "safe.txt" },
    },
    { t: "tool.updated", itemId: "native", output: "partial" },
    { t: "tool.done", itemId: "native", status: "ok", output: "complete" },
  ] as const)
    state = applyEvents(
      state,
      observeRuntimeEvent(state, { ...input, turnId: "turn", itemId: "tool", event }, context)
        .events,
    );
  expect(state.item?.[0]).toMatchObject({
    kind: "tool",
    body: { name: "read", input: { path: "safe.txt" }, output: "complete", status: "ok" },
  });
});
it("ends a turn and expires its three pending requests atomically while preserving another request", () => {
  const state = {
    ...started(),
    interaction: ["a", "b", "c", "other"].map((id) => ({
      id,
      agentId: "profile",
      threadId: "thread",
      turnId: id === "other" ? "another-turn" : "turn",
      type: "question",
      state: "pending",
      version: 1,
      items: [{ id: "q", prompt: "Choose" }],
      chain: [],
      urgency: "blocking",
      createdAt: at,
    })),
  };
  const outcome = observeRuntimeEvent(
    state,
    { ...input, event: { t: "turn.done", turnId: "turn", status: "completed" } },
    context,
  );
  expect(outcome.events).toHaveLength(5);
  const next = applyEvents(state, outcome.events);
  expect(next.turn?.[0]?.status).toBe("completed");
  expect(next.session?.[0]?.state).toBe("ready");
  expect(next.interaction?.filter((row) => row.state === "expired")).toHaveLength(3);
  expect(next.interaction?.find((row) => row.id === "other")?.state).toBe("pending");
  expect(new Set(outcome.events.map((event) => event.eventId)).size).toBe(5);
});
it("does not resurrect a closed session or accept final content after its turn ended", () => {
  const state = started();
  const closed = {
    ...state,
    session: state.session?.map((row) => ({ ...row, state: "closed", endedAt: at })) ?? [],
  };
  const next = applyEvents(
    closed,
    observeRuntimeEvent(
      closed,
      { ...input, event: { t: "turn.done", turnId: "turn", status: "failed" } },
      context,
    ).events,
  );
  expect(next.session?.[0]?.state).toBe("closed");
  expect(next.turn?.[0]?.status).toBe("failed");
  expect(
    observeRuntimeEvent(
      next,
      {
        ...input,
        itemId: "late",
        event: {
          t: "message.done",
          turnId: "turn",
          itemId: "native",
          text: "late",
          phase: "final",
        },
      },
      context,
    ).events,
  ).toEqual([]);
});
it.each([
  "completed",
  "interrupted",
  "failed",
] as const)("ends unfinished tool displays as unconfirmed on %s without inventing a result", (status) => {
  const state = started();
  state.item = [
    {
      id: "tool",
      threadId: "thread",
      turnId: "turn",
      seq: 1,
      kind: "tool",
      body: { status: "running", input: { command: "fixture" } },
      createdAt: at,
      updatedAt: at,
    },
  ];
  const next = applyEvents(
    state,
    observeRuntimeEvent(
      state,
      { ...input, event: { t: "turn.done", turnId: "turn", status } },
      context,
    ).events,
  );
  expect(next.item?.[0]?.body).toMatchObject({
    status: "unconfirmed",
    partial: true,
    input: { command: "fixture" },
  });
  expect((next.item?.[0]?.body as Record<string, unknown>).output).toBeUndefined();
});

it("records ready capabilities without changing native identity or reopening a running state", () => {
  const capabilities = {
    resume: true,
    fork: false,
    steer: "queue_only",
    concurrentTurns: false,
    interrupt: "native",
    modes: [],
    models: { selectable: false },
    effort: [],
    approvals: "none",
    questions: "none",
    planReview: "none",
    elicitation: "none",
    usage: { tokens: false, cost: false, context: false, cache: false },
    compaction: { auto: false, manual: false, events: false },
    hostTools: "none",
    images: false,
    nativeSessions: { list: false, adopt: false, visibleInOfficialApps: "unknown" },
    worktreeAware: false,
  };
  const ready = { t: "session.ready", nativeId: "native", providerVersion: "1", capabilities };
  expect(
    applyEvents(base, observeRuntimeEvent(base, { ...input, event: ready }, context).events)
      .session?.[0],
  ).toMatchObject({ state: "ready", nativeId: "native", providerVersion: "1" });
  const state = started();
  expect(
    applyEvents(state, observeRuntimeEvent(state, { ...input, event: ready }, context).events)
      .session?.[0]?.state,
  ).toBe("running");
  const live = applyEvents(
    state,
    observeRuntimeEvent(state, { ...input, event: ready }, context).events,
  );
  const metadata = observeRuntimeEvent(
    live,
    {
      ...input,
      event: {
        t: "capabilities.updated",
        capabilities: { ...capabilities, slashCommands: [{ name: "updated" }] },
        providerVersion: "2",
      },
    },
    context,
  );
  const updated = applyEvents(live, metadata.events);
  expect(updated.session?.[0]).toMatchObject({
    state: "running",
    nativeId: "native",
    providerVersion: "2",
    capabilities: { slashCommands: [{ name: "updated" }] },
  });
  expect(updated.turn).toEqual(live.turn);
  expect(() =>
    observeRuntimeEvent(
      { ...base, session: base.session.map((row) => ({ ...row, nativeId: "other" })) },
      { ...input, event: ready },
      context,
    ),
  ).toThrow("runtime_native_identity_changed");
});
it("records plan and completed compaction metadata without persisting progress deltas", () => {
  let state = started();
  state = applyEvents(
    state,
    observeRuntimeEvent(
      state,
      {
        ...input,
        itemId: "plan",
        event: {
          t: "plan.updated",
          turnId: "turn",
          entries: [{ step: "Build", status: "pending" }],
        },
      },
      context,
    ).events,
  );
  state = applyEvents(
    state,
    observeRuntimeEvent(
      state,
      {
        ...input,
        turnId: "turn",
        itemId: "compact",
        event: {
          t: "compaction",
          state: "done",
          trigger: "manual",
          tokensBefore: 1000,
          tokensAfter: 100,
        },
      },
      context,
    ).events,
  );
  expect(state.item?.find((row) => row.id === "plan")).toMatchObject({
    kind: "plan",
    body: { entries: [{ step: "Build", status: "pending" }] },
  });
  expect(state.item?.find((row) => row.id === "compact")).toMatchObject({
    kind: "note",
    body: { code: "context_compacted", trigger: "manual", tokensBefore: 1000, tokensAfter: 100 },
  });
});
it("leaves timeout owned requests pending until their native stop has been confirmed", () => {
  const state = {
    ...started(),
    interaction: [
      {
        id: "park",
        agentId: "profile",
        threadId: "thread",
        turnId: "turn",
        type: "question",
        state: "pending",
        version: 1,
        items: [{ id: "q", prompt: "Choose" }],
        chain: [],
        urgency: "blocking",
        createdAt: at,
      },
    ],
  };
  const next = applyEvents(
    state,
    observeRuntimeEvent(
      state,
      {
        ...input,
        heldInteractionIds: ["park"],
        event: { t: "turn.done", turnId: "turn", status: "interrupted" },
      },
      context,
    ).events,
  );
  expect(next.interaction?.[0]?.state).toBe("pending");
  expect(next.turn?.[0]?.status).toBe("interrupted");
  expect(() =>
    observeRuntimeEvent(
      base,
      { ...input, event: { t: "turn.started", turnId: "turn" } },
      { ...context, actor: { kind: "agent", id: "profile" } },
    ),
  ).toThrow("system_runtime_writer_required");
});
it("caches a completion observed without its start and fences later partial updates", () => {
  let state = started();
  state = applyEvents(
    state,
    observeRuntimeEvent(
      state,
      {
        ...input,
        turnId: "turn",
        itemId: "partial-tool",
        event: { t: "tool.done", itemId: "native", status: "ok", output: "complete" },
      },
      context,
    ).events,
  );
  expect(state.item?.[0]).toMatchObject({
    kind: "tool",
    body: { nativeItemId: "native", status: "ok", output: "complete", partial: true },
  });
  expect((state.item?.[0]?.body as Record<string, unknown>).input).toBeUndefined();
  for (const event of [
    { t: "tool.started", turnId: "turn", itemId: "native", name: "read", kind: "read", input: {} },
    { t: "tool.updated", itemId: "native", output: "late partial" },
  ] as const)
    expect(
      observeRuntimeEvent(
        state,
        { ...input, turnId: "turn", itemId: "partial-tool", event },
        context,
      ).events,
    ).toEqual([]);
});
it("records idle manual compaction without inventing a running turn or reopening closed work", () => {
  const state = { ...base, session: base.session.map((row) => ({ ...row, state: "ready" })) };
  expect(
    observeRuntimeEvent(
      state,
      { ...input, event: { t: "compaction", state: "started", trigger: "manual" } },
      context,
    ).result,
  ).toMatchObject({ transient: true });
  const outcome = observeRuntimeEvent(
    state,
    {
      ...input,
      itemId: "idle-compact",
      event: {
        t: "compaction",
        state: "done",
        trigger: "manual",
        tokensBefore: 1000,
        tokensAfter: 100,
      },
    },
    context,
  );
  const next = applyEvents(state, outcome.events);
  expect(next.turn ?? []).toEqual([]);
  expect(next.session?.[0]?.state).toBe("ready");
  expect(next.item?.[0]).toMatchObject({
    threadId: "thread",
    kind: "note",
    seq: 1,
    body: { code: "context_compacted", trigger: "manual", tokensBefore: 1000, tokensAfter: 100 },
  });
  expect(next.item?.[0]?.turnId).toBeUndefined();
  const repeated = applyEvents(
    next,
    observeRuntimeEvent(
      next,
      {
        ...input,
        itemId: "idle-compact",
        event: { t: "compaction", state: "done", trigger: "manual" },
      },
      context,
    ).events,
  );
  expect(repeated.item).toHaveLength(1);
});
it("fences compaction against another session's turn and an unrelated display item", () => {
  const state = {
    ...started(),
    turn: [
      ...(started().turn ?? []),
      { id: "foreign", sessionId: "other", threadId: "other", status: "running" },
    ],
    item: [
      {
        id: "message",
        threadId: "thread",
        turnId: "turn",
        kind: "message",
        seq: 1,
        body: { text: "Kept" },
        createdAt: at,
        updatedAt: at,
      },
    ],
  };
  const event = { t: "compaction", state: "done", trigger: "manual" } as const;
  expect(() =>
    observeRuntimeEvent(state, { ...input, turnId: "foreign", itemId: "compact", event }, context),
  ).toThrow("runtime_turn_missing");
  expect(() =>
    observeRuntimeEvent(state, { ...input, turnId: "turn", itemId: "message", event }, context),
  ).toThrow("runtime_item_conflict");
});
it("keeps provider tool titles and interactive flags on the tool item body", () => {
  const state = started();
  const outcome = observeRuntimeEvent(
    state,
    {
      ...input,
      turnId: "turn",
      itemId: "ask",
      event: {
        t: "tool.started",
        turnId: "turn",
        itemId: "native-ask",
        name: "AskUserQuestion",
        kind: "other",
        input: {},
        title: "Choose a database",
        interactive: true,
        parentItemId: "native-agent",
      },
    },
    context,
  );
  expect(applyEvents(state, outcome.events).item?.[0]?.body).toMatchObject({
    title: "Choose a database",
    interactive: true,
    parentItemId: "native-agent",
    status: "running",
  });
});
it("projects mode changes and background tasks between turns without a running turn", () => {
  let state: ReturnType<typeof started> = {
    ...base,
    session: base.session.map((row) => ({ ...row, state: "ready" })),
  };
  const observe = (event: Record<string, unknown>) => {
    const outcome = observeRuntimeEvent(state, { ...input, event }, context);
    state = applyEvents(state, outcome.events);
    return outcome;
  };
  expect(observe({ t: "mode.changed", mode: "plan" }).result).toEqual({ mode: "plan" });
  expect(observe({ t: "mode.changed", mode: "plan" }).result).toEqual({ ignored: true });
  const task = (id: string, extra: Record<string, unknown> = {}) => ({
    t: "background.updated",
    task: { id, kind: "shell", description: `npm run ${id}`, state: "running", ...extra },
  });
  observe(task("dev"));
  observe(task("test"));
  observe(task("dev", { state: "completed", summary: "exited 0" }));
  expect(observe(task("dev")).result).toEqual({ ignored: true });
  expect(state.session?.[0]).toMatchObject({
    mode: "plan",
    state: "ready",
    background: [
      { id: "dev", state: "completed", summary: "exited 0" },
      { id: "test", state: "running" },
    ],
  });
  for (let index = 0; index < 60; index++) observe(task(`job-${index}`, { state: "completed" }));
  const background = state.session?.[0]?.background as { id: string; state: string }[];
  expect(background).toHaveLength(50);
  // Finished entries fall off first, so a running task stays stoppable.
  expect(background[0]?.id).toBe("test");
  expect(background.at(-1)?.id).toBe("job-59");
  expect(state.turn ?? []).toEqual([]);
  const closed = {
    ...state,
    session: (state.session ?? []).map((row) => ({ ...row, state: "closed" })),
  };
  expect(
    observeRuntimeEvent(
      closed,
      { ...input, event: { t: "mode.changed", mode: "default" } },
      context,
    ).result,
  ).toEqual({ ignored: true });
});
