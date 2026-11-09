import { expect, it } from "vitest";
import { InteractionEngine } from "../interaction-engine.js";
import { chiefFragments } from "./digest.js";
import { wakeMessage } from "./proactive.js";
import {
  agreement,
  type ChiefQueue,
  chiefQueue,
  compareOutcome,
  lessonCandidates,
  queueOrder,
  settleQueue,
} from "./queue.js";
import { at, chiefFixture } from "./test-fixture.js";
import { respondChiefApproval } from "./tools.js";

it("triages Needs you without answering anything, and the digest follows that order", async () => {
  const { f, call, request, settingValue } = await chiefFixture();
  try {
    const deploy = request("worker", { type: "approval", title: "Deploy to staging" });
    const color = request("worker", {
      type: "question",
      title: "Which color?",
      options: ["blue", "green"],
    });
    const tests = request("worker", { type: "approval", title: "Run npm test" });
    const result = await call("chief_triage", {
      items: [
        {
          interactionId: tests,
          rank: "now",
          why: "Read-only, unblocks the fix",
          recommend: "approve",
        },
        {
          interactionId: color,
          rank: "today",
          why: "Brand says blue",
          recommend: "answer",
          choice: "blue",
        },
        { interactionId: deploy, rank: "later", why: "Wait for review" },
        { interactionId: "missing", rank: "now", why: "Gone" },
        { interactionId: color, rank: "now", why: "x", recommend: "answer", choice: "red" },
      ],
    });
    // The bad option on the repeated item is refused; the first triage of it stands.
    expect(result).toEqual({
      saved: 3,
      refused: [
        { interactionId: "missing", error: "not_pending" },
        { interactionId: color, error: "unknown_option" },
      ],
    });
    expect(settingValue("chief.queue")).toMatchObject({
      items: {
        [tests]: {
          rank: "now",
          recommend: { decision: "approve" },
          kind: "approval:approval:coach",
        },
        [color]: { rank: "today", recommend: { decision: "answer", choice: "blue" } },
        [deploy]: { rank: "later" },
      },
    });
    const state = f.store.snapshot();
    expect(queueOrder(state).map((row) => row.id)).toEqual([tests, color, deploy]);
    expect(state.interaction?.every((row) => row.state === "pending")).toBe(true);
    const digest = chiefFragments(f.store, "thread")[0]?.text ?? "";
    expect(digest).toContain("Needs you, in the user's queue order (3):");
    expect(digest).toContain(
      `1. [now] approval "Run npm test" in "Fix onboarding" (${tests}) | you: approve, Read-only, unblocks the fix`,
    );
    expect(digest).toContain(
      `2. [today] question "Which color?" in "Fix onboarding" (${color}) options: blue/green`,
    );
  } finally {
    f.close();
  }
});

it("clears the queue from what the user said, after one confirmation, as the user's answers", async () => {
  const { f, call, request, said, pending, queued, answered, human, context, wakes } =
    await chiefFixture();
  try {
    const one = request("worker", { type: "approval", title: "Run npm test" });
    const two = request("worker", { type: "approval", title: "Edit README" });
    const three = request("worker", { type: "approval", title: "Deploy" });
    const four = request("worker", { type: "question", title: "Which database?" });
    // Without a message from the user in this turn, Zolt cannot prepare answers.
    said("Wake-up", {}, "chief-wake:1");
    expect(
      await call("chief_answer", {
        key: "a",
        items: [{ interactionId: one, decision: "approve" }],
      }),
    ).toMatchObject({ error: "user_message_required" });
    said("approve the first two, decline the deploy, tell it to use Postgres");
    const card = await call("chief_answer", {
      key: "clear",
      items: [
        { interactionId: one, decision: "approve" },
        { interactionId: two, decision: "approve" },
        { interactionId: three, decision: "decline", text: "Not before review" },
        { interactionId: four, decision: "answer", text: "Use Postgres" },
        { interactionId: four, decision: "approve" },
        { interactionId: "gone", decision: "approve" },
      ],
    });
    expect(card).toMatchObject({
      status: "pending",
      refused: [
        { interactionId: four, error: "duplicate" },
        { interactionId: "gone", error: "not_pending" },
      ],
    });
    const approval = pending(card.interactionId);
    expect(approval.title).toBe("Zolt: send your answers");
    expect(approval.items[0]?.prompt).toBe(
      [
        "Send these 4 answers for you:",
        "",
        '1. "Run npm test": approve once',
        '2. "Edit README": approve once',
        '3. "Deploy": decline, saying "Not before review"',
        '4. "Which database?": answer "Use Postgres"',
      ].join("\n"),
    );
    // Nothing is answered until the user confirms the card.
    expect(answered).toEqual([]);
    // Meanwhile one item is answered elsewhere: it is skipped and reported.
    f.store.dispatch("elsewhere", (state) => {
      const row = state.interaction?.find((entry) => entry.id === two);
      return {
        events: [
          {
            eventId: "elsewhere:0",
            aggregateType: "interaction",
            aggregateId: two,
            type: "interaction.updated",
            occurredAt: at,
            payload: { ...row, state: "answered", version: Number(row?.version) + 1 },
          },
        ],
        result: {},
      };
    });
    const confirm = { action: "accept" as const, choice: "allow_once", by: human, at };
    await respondChiefApproval(context, approval, confirm);
    expect(answered).toHaveLength(1);
    expect(answered[0]?.items).toEqual([
      expect.objectContaining({
        id: one,
        answer: expect.objectContaining({ action: "accept", choice: "allow_once", by: human }),
      }),
      expect.objectContaining({
        id: three,
        answer: expect.objectContaining({ action: "decline", feedback: "Not before review" }),
      }),
      expect.objectContaining({
        id: four,
        answer: expect.objectContaining({
          action: "accept",
          answers: { answer: { other: "Use Postgres" } },
        }),
      }),
    ]);
    const audits = (f.store.snapshot(["audit"]).audit ?? []).filter(
      (row) => row.action === "chief.answer",
    );
    expect(audits).toHaveLength(3);
    expect(audits[0]).toMatchObject({
      actor: human,
      detail: { relay: { kind: "agent", id: "profile" } },
    });
    expect(queued("thread").at(-1)?.text).toBe(
      '[Zoltbot] Skipped 1 that changed or were answered elsewhere: "Edit README".',
    );
    expect(wakes).toEqual(["thread"]);
    // Confirming twice sends nothing again.
    await respondChiefApproval(context, approval, confirm);
    expect(answered).toHaveLength(1);
  } finally {
    f.close();
  }
});

it("never prepares answers from a notice that only reported an earlier approval", async () => {
  const { f, call, request, said } = await chiefFixture();
  try {
    const one = request("worker", { type: "approval", title: "Run npm test" });
    said("[Zoltbot] Approved: sent your message.", { sourceInteractionId: "earlier" });
    expect(
      await call("chief_answer", {
        key: "a",
        items: [{ interactionId: one, decision: "approve" }],
      }),
    ).toMatchObject({ error: "user_message_required" });
  } finally {
    f.close();
  }
});

it("compares the user's answer with the recommendation", () => {
  const by = { kind: "human" as const, id: "owner" };
  expect(
    compareOutcome({ decision: "approve" }, { action: "accept", choice: "allow_once", by, at }),
  ).toEqual({ result: "agreed" });
  expect(
    compareOutcome({ decision: "approve" }, { action: "decline", feedback: "no", by, at }),
  ).toEqual({
    result: "overruled",
    instead: "declined",
    feedback: "no",
  });
  expect(compareOutcome({ decision: "decline" }, { action: "accept", by, at })).toMatchObject({
    result: "overruled",
  });
  expect(
    compareOutcome(
      { decision: "answer", choice: "blue" },
      { action: "accept", answers: { a: { options: ["green"] } }, by, at },
    ),
  ).toEqual({ result: "overruled", instead: "green" });
  expect(
    compareOutcome(
      { decision: "answer", text: "Use Postgres" },
      { action: "accept", answers: { a: { other: "Use Postgres 16" } }, by, at },
    ),
  ).toEqual({ result: "edited" });
  expect(compareOutcome({ decision: "approve" }, { action: "timeout", by, at })).toBeUndefined();
  expect(compareOutcome(undefined, { action: "accept", by, at })).toBeUndefined();
});

it("settles outcomes, measures agreement and finds patterns worth a lesson", () => {
  const triage = (id: string, decision: "approve" | "decline") => ({
    rank: "now" as const,
    why: "",
    recommend: { decision },
    at,
    threadId: "worker",
    kind: "approval:Bash:coach",
    title: `Run ${id}`,
  });
  const resolved = (id: string, action: "accept" | "decline" | "expire") => ({
    id,
    state: action === "expire" ? "expired" : "answered",
    resolution: { action, by: { kind: "human", id: "owner" }, at },
  });
  const state = {
    settings: [
      {
        key: "chief.queue",
        value: {
          items: {
            a: triage("a", "approve"),
            b: triage("b", "approve"),
            c: triage("c", "approve"),
            d: triage("d", "approve"),
            e: triage("e", "approve"),
            gone: triage("gone", "approve"),
          },
        },
      },
    ],
    interaction: [
      resolved("a", "decline"),
      resolved("b", "decline"),
      resolved("c", "decline"),
      resolved("d", "accept"),
      resolved("e", "expire"),
    ],
  };
  const queue = settleQueue(state, at) as ChiefQueue;
  expect(Object.keys(queue.items).sort()).toEqual(["a", "b", "c", "d", "e"]);
  expect(queue.items.e?.outcome?.result).toBe("skipped");
  expect(agreement(queue, new Date(at))).toEqual({ agreed: 1, total: 4 });
  const [lesson] = lessonCandidates(queue);
  expect(lesson).toMatchObject({
    kind: "approval:Bash:coach",
    count: 3,
    evidence: ["a", "b", "c"],
  });
  expect(lesson?.examples[0]).toBe('"Run a": you said approve, user declined');
  // Once settled, nothing changes until another item resolves.
  expect(
    settleQueue({ ...state, settings: [{ key: "chief.queue", value: queue }] }, at),
  ).toBeUndefined();
});

it("sends confirmed answers through the real interaction engine from inside the card's answer", async () => {
  const { f, call, request, said, context, human } = await chiefFixture();
  try {
    const replies: { id: string; action: string; by: string }[] = [];
    const engine: InteractionEngine = new InteractionEngine({
      store: f.store,
      publish() {},
      host: {
        registerSecret() {},
        requiresSecretReply: () => false,
        respond: (interaction, answer) =>
          (interaction.context?.toolInput as { chiefAction?: unknown } | undefined)?.chiefAction
            ? respondChiefApproval(context, interaction, answer)
            : Promise.resolve(
                void replies.push({
                  id: interaction.id,
                  action: answer.action,
                  by: answer.by.kind,
                }),
              ),
      },
    });
    context.answer = (items, commandId) =>
      engine.batch(items, commandId, {
        kind: "human",
        id: "local-owner",
      });
    const one = request("worker", { type: "approval", title: "Run npm test" });
    const two = request("worker", {
      type: "question",
      title: "Color?",
      options: ["blue", "green"],
    });
    said("approve the tests and pick green");
    const card = await call("chief_answer", {
      key: "clear",
      items: [
        { interactionId: one, decision: "approve" },
        { interactionId: two, decision: "answer", choice: "Green" },
      ],
    });
    const approval = f.store
      .snapshot(["interaction"])
      .interaction?.find((row) => row.id === card.interactionId);
    await engine.answer(
      String(card.interactionId),
      Number(approval?.version),
      { action: "accept", choice: "allow_once", by: human, at },
      "confirm-card",
      human,
    );
    const rows = new Map(
      (f.store.snapshot(["interaction"]).interaction ?? []).map((row) => [row.id, row]),
    );
    expect(rows.get(one)).toMatchObject({
      state: "answered",
      resolution: { action: "accept", choice: "allow_once", by: { kind: "human" } },
    });
    expect(rows.get(two)).toMatchObject({
      state: "answered",
      resolution: { answers: { answer: { options: ["green"] } }, by: { kind: "human" } },
    });
    expect(replies).toEqual([
      { id: one, action: "accept", by: "human" },
      { id: two, action: "accept", by: "human" },
    ]);
  } finally {
    f.close();
  }
});

it("turns three overrules of one kind into a single preference the user must approve", async () => {
  const { f, call, request, put, change, human } = await chiefFixture();
  try {
    const ids = ["one", "two", "three", "four"].map((name) =>
      request("worker", { type: "approval", title: `Deploy ${name}`, toolName: "Bash" }),
    );
    await call("chief_triage", {
      items: ids.map((interactionId) => ({
        interactionId,
        rank: "now",
        why: "Tests passed",
        recommend: "approve",
      })),
    });
    // Decided just now, so they count toward this week's agreement rate.
    const now = new Date().toISOString();
    for (const id of ids.slice(0, 3))
      put("interaction", id, {
        state: "answered",
        resolution: { action: "decline", feedback: "Not on Fridays", by: human, at: now },
      });
    put("interaction", ids[3] as string, {
      state: "answered",
      resolution: { action: "accept", choice: "allow_once", by: human, at: now },
    });
    const settled = settleQueue(f.store.snapshot(), at);
    change({ type: "update", kind: "settings", id: "chief.queue", changes: { value: settled } });
    const digest = chiefFragments(f.store, "thread")[0]?.text ?? "";
    expect(digest).toContain(
      "Your recommendations matched the user's call on 1 of 4 in the last 7 days.",
    );
    expect(digest).toContain("Pattern: the user overruled you 3 times on approval:Bash:coach");
    expect(wakeMessage(f.store.snapshot(), [])).toContain(
      `Propose one preference with chief_learn, citing ${ids.slice(0, 3).join(", ")}.`,
    );
    expect(await call("chief_learn", { title: "x", body: "y", evidence: [ids[3]] })).toMatchObject({
      error: "evidence_must_be_unlearned_overrules",
    });
    const proposed = await call("chief_learn", {
      title: "No deploys on Fridays",
      body: "Recommend declining deploys on Fridays unless the user says it is urgent.",
      evidence: ids.slice(0, 3),
    });
    expect(proposed).toMatchObject({ status: "proposed" });
    const state = f.store.snapshot(["knowledge", "knowledgeProposal", "settings"]);
    expect(state.knowledge ?? []).toEqual([]);
    expect(state.knowledgeProposal).toEqual([
      expect.objectContaining({
        id: proposed.proposalId,
        state: "pending",
        scope: { type: "user", id: "local" },
        kind: "preference",
        title: "No deploys on Fridays",
        why: "user_scope",
        threadId: "thread",
        evidence: [{ kind: "thread", ref: "worker", label: "Deploy one" }],
      }),
    ]);
    expect(lessonCandidates(chiefQueue(state))).toEqual([]);
    expect(chiefFragments(f.store, "thread")[0]?.text).not.toContain("Pattern:");
    expect(
      await call("chief_learn", { title: "Again", body: "Again", evidence: ids.slice(0, 1) }),
    ).toMatchObject({ error: "evidence_must_be_unlearned_overrules" });
  } finally {
    f.close();
  }
});
