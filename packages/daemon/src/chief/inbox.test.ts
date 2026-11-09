import { InteractionSchema, parse } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { chiefFragments } from "./digest.js";
import { type ChiefInboxEntry, chiefInbox } from "./inbox.js";
import { chiefSignals } from "./proactive.js";
import { chiefQueue, settleQueue } from "./queue.js";
import { at, chiefFixture } from "./test-fixture.js";
import { respondChiefIdea } from "./tools.js";

async function setup() {
  const fixture = await chiefFixture();
  const lead = {
    agentId: "profile",
    threadId: "worker",
    sessionId: "worker-session",
    turnId: "worker-turn",
  };
  let calls = 0;
  /** The lead's own tool call, as a workspace chat makes it. */
  const send = (args: Record<string, unknown>) => {
    const tool = fixture.tools.tools.get("team_message");
    if (!tool) throw new Error("missing_tool");
    return tool({ actor: lead, arguments: args, idempotencyKey: `lead:${++calls}` }) as Promise<
      Record<string, unknown>
    >;
  };
  const inbox = () => chiefInbox(fixture.f.store.snapshot(["settings"]));
  return { ...fixture, lead, send, inbox };
}

it("takes ideas, updates and questions from leads, three ideas a day at most", async () => {
  const { f, send, inbox, tools, lead } = await setup();
  try {
    expect(tools.authorize(lead, "team_message", { to: "chief" })).toBe(true);
    expect(
      await send({
        key: "cache",
        to: "chief",
        idea: true,
        text: "Cache the onboarding config; three chats re-fetch it.",
      }),
    ).toMatchObject({ to: "chief", delivered: "queued" });
    // A retry with the same key adds nothing.
    await send({ key: "cache", to: "chief", idea: true, text: "Cache the onboarding config." });
    await send({ key: "status", to: "Chief", text: "Onboarding tests pass again." });
    await send({
      key: "ask",
      to: "chief",
      question: true,
      text: "Should I also fix the iOS flow?",
    });
    await send({ key: "two", to: "chief", idea: true, text: "Split the settings page." });
    await send({ key: "three", to: "chief", idea: true, text: "Delete the old importer." });
    expect(await send({ key: "four", to: "chief", idea: true, text: "One more." })).toMatchObject({
      error: "idea_limit",
    });
    expect(
      inbox().map((entry) => [entry.kind, entry.fromTitle, entry.place, entry.status]),
    ).toEqual([
      ["idea", "Fix onboarding", "Coach V2", "new"],
      ["update", "Fix onboarding", "Coach V2", "new"],
      ["question", "Fix onboarding", "Coach V2", "new"],
      ["idea", "Fix onboarding", "Coach V2", "new"],
      ["idea", "Fix onboarding", "Coach V2", "new"],
    ]);
    // Nothing reaches the user directly, and no other chat gets a message.
    expect(f.store.snapshot(["interaction"]).interaction ?? []).toEqual([]);
    expect(f.store.snapshot(["message"]).message ?? []).toEqual([]);
    const digest = chiefFragments(f.store, "thread")[0]?.text ?? "";
    expect(digest).toContain("From leads (5; promote or drop ideas with chief_idea");
    expect(digest).toContain(
      `- idea ${inbox()[0]?.id} from "Fix onboarding" [Coach V2]: Cache the onboarding config; three chats re-fetch it.`,
    );
    // A question from a lead can wake Zolt; ideas and updates wait for its next turn.
    expect(chiefSignals(f.store.snapshot(), Date.parse(at) + 3_600_000).map((s) => s.kind)).toEqual(
      ["question"],
    );
  } finally {
    f.close();
  }
});

it("promotes merged ideas into the queue as one question that never notifies", async () => {
  const { f, send, inbox, call, pending } = await setup();
  try {
    await send({ key: "a", to: "chief", idea: true, text: "Cache the onboarding config." });
    await send({
      key: "b",
      to: "chief",
      idea: true,
      text: "Onboarding fetches config three times.",
    });
    await send({ key: "c", to: "chief", text: "Done with the fix." });
    const [first, second, update] = inbox() as ChiefInboxEntry[];
    expect(await call("chief_idea", { op: "promote", ids: [first?.id], key: "k" })).toMatchObject({
      error: "key_title_and_why_required",
    });
    expect(
      await call("chief_idea", {
        op: "promote",
        ids: [update?.id],
        key: "k",
        title: "x",
        why: "y",
      }),
    ).toMatchObject({ error: "unknown_idea" });
    const promoted = await call("chief_idea", {
      op: "promote",
      ids: [first?.id, second?.id],
      key: "cache-config",
      title: "Cache the onboarding config",
      why: "Three chats re-fetch it on every run.",
    });
    expect(promoted).toMatchObject({ status: "queued" });
    const question = pending(promoted.interactionId);
    expect(question).toMatchObject({
      type: "question",
      threadId: "thread",
      title: "Idea: Cache the onboarding config",
      urgency: "background",
    });
    expect(question.items[0]?.prompt).toBe(
      "Idea from Fix onboarding (Coach V2): Cache the onboarding config\nWhy: Three chats re-fetch it on every run.",
    );
    expect(question.items[0]?.options?.map((option) => option.label)).toEqual([
      "Start it",
      "Not now",
      "Never like this",
    ]);
    expect(chiefQueue(f.store.snapshot()).items[question.id]).toMatchObject({
      rank: "later",
      recommend: { decision: "answer", choice: "start" },
      kind: "question:idea:none",
    });
    expect(inbox().map((entry) => entry.status)).toEqual(["promoted", "promoted", "new"]);
    expect(
      await call("chief_idea", {
        op: "promote",
        ids: [first?.id],
        key: "again",
        title: "x",
        why: "y",
      }),
    ).toMatchObject({ error: "already_handled" });
    expect(await call("chief_idea", { op: "drop", ids: [update?.id] })).toEqual({ dropped: 1 });
    expect(inbox().map((entry) => entry.status)).toEqual(["promoted", "promoted", "done"]);
  } finally {
    f.close();
  }
});

it("asks Zolt for a brief when the user starts an idea, and learns from never", async () => {
  const { f, send, call, pending, context, human, queued, wakes, put, inbox } = await setup();
  try {
    await send({ key: "a", to: "chief", idea: true, text: "Cache the onboarding config." });
    const start = await call("chief_idea", {
      op: "promote",
      ids: [inbox()[0]?.id],
      key: "cache",
      title: "Cache the onboarding config",
      why: "Saves three fetches.",
    });
    const own = await call("chief_idea", {
      op: "promote",
      key: "dark",
      title: "Add a dark theme",
      why: "Two chats asked for it.",
    });
    expect(pending(own.interactionId).items[0]?.prompt).toMatch(
      /^Idea from Zolt: Add a dark theme/,
    );
    const choose = async (id: unknown, option: string) => {
      const request = pending(id);
      const answer = {
        action: "accept" as const,
        answers: { idea: { options: [option] } },
        by: human,
        at,
      };
      put("interaction", request.id, { state: "answered", resolution: answer });
      await respondChiefIdea(context, request, answer);
    };
    await choose(start.interactionId, "start");
    expect(queued("thread").at(-1)?.text).toBe(
      '[Zoltbot] The user wants to start the idea "Cache the onboarding config". Propose chief_start_chat with a complete brief.',
    );
    expect(wakes).toEqual(["thread"]);
    expect(inbox()[0]?.answer).toBe("start");
    await choose(own.interactionId, "never");
    expect(queued("thread")).toHaveLength(1);
    expect(wakes).toHaveLength(1);
    const queue = settleQueue(f.store.snapshot(), at);
    expect(queue?.items[String(start.interactionId)]?.outcome?.result).toBe("agreed");
    expect(queue?.items[String(own.interactionId)]?.outcome).toMatchObject({
      result: "overruled",
      instead: "never",
    });
    expect(parse(InteractionSchema, pending(own.interactionId)).state).toBe("answered");
  } finally {
    f.close();
  }
});
