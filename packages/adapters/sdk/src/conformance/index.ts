import {
  type AgentEvent,
  AgentEventSchema,
  type InteractionAnswer,
  parse,
  type UserInput,
} from "@zoltbot/protocol";
import type { AgentSession } from "../interface.js";

export const scenarios = [
  "open",
  "stream",
  "tools",
  "approve",
  "reject",
  "question",
  "plan",
  "interrupt",
  "queue",
  "steer",
  "resume",
  "crash",
  "hang",
  "unknown",
  "malformed",
  "usage",
  "compact",
  "close_pending",
  "duplicate_questions",
  "host_tools",
  "environment",
  "frame_log",
  "background",
  "rewind",
] as const;
export type Scenario = (typeof scenarios)[number];
export interface ConformanceContext {
  cwd?: string;
  session: AgentSession;
  trace: AgentEvent[];
  reopen(nativeId: string): Promise<AgentSession>;
  frameLog(): Promise<string>;
  childEnvironment(): Promise<Record<string, string>>;
  dispose(): Promise<void>;
}
export type ConformanceFactory = (scenario: Scenario) => Promise<ConformanceContext>;
const input = (text: string): UserInput => [{ type: "text", text }];
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Conformance failure: ${message}`);
}
async function wait(
  trace: AgentEvent[],
  test: (event: AgentEvent) => boolean,
  // Leave room for a fixture RPC deadline to produce its required error event.
  timeout = 10000,
): Promise<AgentEvent> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const event = trace.find(test);
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(
    `Conformance failure: event deadline; trace ${JSON.stringify(trace).slice(-6000)}`,
  );
}
async function send(ctx: ConformanceContext, text: string) {
  return ctx.session.send(input(text), "queue");
}
const done = (e: AgentEvent) => e.t === "turn.done";
const interaction = (e: AgentEvent) => e.t === "interaction.requested";
const answer = (choice = "allow_once"): InteractionAnswer => ({
  action: choice === "reject_once" ? "decline" : "accept",
  choice,
  by: { kind: "human", id: "test-owner" },
  at: "2026-10-27T12:00:00.000Z",
});
export async function runConformance(factory: ConformanceFactory, scenario: Scenario) {
  const ctx = await factory(scenario);
  const { session, trace } = ctx;
  try {
    const ready = await wait(trace, (e) => e.t === "session.ready");
    check(ready.t === "session.ready" && ready.nativeId, "native session id missing");
    switch (scenario) {
      case "open":
        check(session.nativeId === ready.nativeId, "session handle and ready ids differ");
        break;
      case "stream": {
        await send(ctx, "normal");
        await wait(trace, done);
        check(
          trace.some((e) => e.t === "text.delta" && e.text.length > 0),
          "missing text deltas",
        );
        check(
          trace.some((e) => e.t === "message.done" && e.phase === "final" && e.text === "ok"),
          "missing authoritative final message",
        );
        break;
      }
      case "tools":
        await send(ctx, "tools");
        await wait(trace, done);
        for (const status of ["ok", "error"] as const)
          check(
            trace.some((e) => e.t === "tool.done" && e.status === status),
            `missing ${status} tool result`,
          );
        check(
          trace.some((e) => e.t === "tool.done" && e.diffs?.length),
          "edit diff missing",
        );
        check(
          trace.some((e) => e.t === "tool.updated" && e.output),
          "execute output missing",
        );
        break;
      case "approve":
      case "reject": {
        await send(ctx, "approval");
        const e = await wait(trace, interaction);
        check(e.t === "interaction.requested", "approval missing");
        check(e.interaction.type === "approval", "wrong interaction kind");
        await session.respond(
          e.interaction.id,
          answer(
            e.interaction.items
              .flatMap((i) => i.options ?? [])
              .find(
                (o) => o.description === (scenario === "approve" ? "allow_once" : "reject_once"),
              )?.id ?? (scenario === "approve" ? "allow_once" : "reject_once"),
          ),
        );
        await wait(trace, done);
        check(
          trace.some(
            (e) => e.t === "tool.done" && e.status === (scenario === "approve" ? "ok" : "denied"),
          ),
          "approval reply not reflected by provider",
        );
        break;
      }
      case "question":
      case "duplicate_questions": {
        if (session.capabilities.questions === "none") {
          check(
            ["form", "none"].includes(session.capabilities.elicitation),
            "invalid question fallback",
          );
          break;
        }
        await send(ctx, scenario);
        if (session.capabilities.questionFeatures?.maxItems === 1) {
          const seen = new Set<string>();
          const prompts: string[] = [];
          const labels: string[] = [];
          for (let step = 0; step < 2; step++) {
            const current = await wait(
              trace,
              (event) =>
                interaction(event) &&
                event.t === "interaction.requested" &&
                !seen.has(event.interaction.id),
            );
            check(current.t === "interaction.requested", "serial question missing");
            const request = current.interaction;
            check(
              request.type === "question" && request.items.length === 1,
              "single question contract missing",
            );
            seen.add(request.id);
            const item = request.items[0];
            check(item && !item.multi, "unexpected multi selection");
            prompts.push(item.prompt);
            const option = item.options?.[0];
            check(
              step === 0 ? option && !item.allowOther : item.allowOther,
              "serial selection and input missing",
            );
            if (option) labels.push(option.label);
            await session.respond(request.id, {
              ...answer(),
              answers: {
                [item.id]: option ? { options: [option.id] } : { other: "free text" },
              },
            });
          }
          if (scenario === "duplicate_questions")
            check(prompts[0] === prompts[1], "duplicate serial prompts missing");
          await wait(trace, done);
          const output = JSON.stringify(trace.filter((event) => event.t === "tool.done"));
          check(
            output.includes(labels[0] ?? "missing-option") && output.includes("free text"),
            "serial answers did not reach provider",
          );
          check(
            trace.filter((event) => event.t === "interaction.cleared").length === 2,
            "serial questions not resolved independently",
          );
          break;
        }
        const e = await wait(trace, interaction);
        check(e.t === "interaction.requested", "question missing");
        const features = session.capabilities.questionFeatures ?? {
          multi: true,
          other: true,
          recommended: true,
        };
        const items = e.interaction.items;
        check(e.interaction.type === "question" && items.length === 2, "question items missing");
        check(
          !features.recommended || items[0]?.options?.some((o) => o.recommended),
          "recommended flag missing",
        );
        check(!features.multi || items[0]?.multi, "multi select missing");
        check(!features.other || items[1]?.allowOther, "free text support missing");
        check(features.other || !items[1]?.allowOther, "unadvertised free text support");
        check(new Set(items.map((i) => i.id)).size === 2, "duplicate item ids");
        if (scenario === "duplicate_questions")
          check(items[0]?.prompt === items[1]?.prompt, "duplicate text fixture not exercised");
        await session.respond(e.interaction.id, {
          ...answer(),
          answers: {
            [items[0]?.id ?? "q1"]: {
              options: (items[0]?.options ?? []).slice(0, features.multi ? 2 : 1).map((o) => o.id),
            },
            [items[1]?.id ?? "q2"]: features.other
              ? { other: "free text" }
              : { options: (items[1]?.options ?? []).slice(0, 1).map((o) => o.id) },
          },
        });
        await wait(trace, done);
        check(
          trace.some(
            (e) =>
              e.t === "tool.done" &&
              JSON.stringify(e.output).includes(
                features.other ? "free text" : (items[1]?.options?.[0]?.id ?? "missing-option"),
              ),
          ),
          "question answer did not reach provider",
        );
        break;
      }
      case "plan": {
        if (session.capabilities.planReview === "none") {
          check(true, "capability fallback");
          break;
        }
        await send(ctx, "plan");
        const e = await wait(trace, interaction);
        check(
          e.t === "interaction.requested" && e.interaction.type === "plan",
          "plan mapping missing",
        );
        await session.respond(e.interaction.id, answer());
        await wait(trace, done);
        break;
      }
      case "interrupt":
        await send(ctx, "slow");
        await wait(trace, (e) => e.t === "turn.started");
        await session.interrupt();
        await wait(trace, (e) => e.t === "turn.done" && e.status === "interrupted");
        await send(ctx, "normal");
        await wait(trace, (e) => e.t === "turn.done" && e.status === "completed");
        break;
      case "queue":
        await send(ctx, "slow");
        await send(ctx, "normal");
        await wait(
          trace,
          (e) => e.t === "turn.done" && trace.filter((x) => x.t === "turn.done").length === 2,
        );
        check(trace.filter((e) => e.t === "turn.started").length === 2, "queued input lost");
        break;
      case "steer": {
        if (session.capabilities.steer !== "native") {
          check(session.capabilities.steer === "queue_only", "invalid steer capability");
          break;
        }
        await send(ctx, "slow");
        const started = await wait(trace, (e) => e.t === "turn.started");
        await session.send(input("steered"), "steer");
        await wait(trace, done);
        check(
          trace.some(
            (e) =>
              e.t === "text.delta" &&
              e.text === "steered" &&
              started.t === "turn.started" &&
              e.turnId === started.turnId,
          ),
          "steer did not land in running turn",
        );
        break;
      }
      case "resume": {
        check(session.capabilities.resume, "reference scenario requires native resume");
        const id = session.nativeId;
        check(id, "missing native id");
        await session.close();
        const resumed = await ctx.reopen(id);
        check(resumed.nativeId === id, "resume replaced native identity");
        await resumed.send(input("normal"), "queue");
        await wait(trace, (e) => e.t === "message.done" && e.text === "ok");
        await resumed.close();
        break;
      }
      case "crash":
        await send(ctx, "crash");
        await wait(trace, (e) => e.t === "status" && e.state === "error");
        check(
          trace.some((e) => e.t === "interaction.cleared" && e.reason === "process_died"),
          "crash left a pending interaction",
        );
        break;
      case "hang":
        await send(ctx, "hang");
        await wait(trace, (e) => e.t === "status" && e.state === "error");
        break;
      case "unknown":
        await send(ctx, "unknown");
        await wait(trace, done);
        check((await ctx.frameLog()).includes("future_event"), "unknown frame not logged");
        break;
      case "malformed":
        await send(ctx, "malformed");
        await wait(trace, (e) => e.t === "status" && e.state === "error");
        check((await ctx.frameLog()).length > 0, "malformed known frame not logged");
        break;
      case "usage":
        await send(ctx, "usage");
        await wait(trace, done);
        if (session.capabilities.usage.tokens) {
          check(
            trace.some(
              (e) =>
                e.t === "usage.updated" &&
                e.usage.inputTokens !== undefined &&
                e.usage.cumulative === false,
            ),
            "per turn usage missing",
          );
        } else {
          check(
            session.capabilities.usage.context &&
              trace.some(
                (e) =>
                  e.t === "usage.updated" &&
                  e.usage.contextUsed !== undefined &&
                  e.usage.contextSize !== undefined,
              ),
            "advertised context usage missing",
          );
        }
        check(
          trace.some((e) => e.t === "usage.updated" && e.usage.cumulative === true),
          "cumulative usage missing",
        );
        break;
      case "compact": {
        if (!session.capabilities.compaction.manual) {
          check(!session.capabilities.compaction.manual, "manual compaction unavailable");
          break;
        }
        await session.compact();
        await wait(trace, (e) => e.t === "compaction" && e.state === "done");
        break;
      }
      case "close_pending":
        await send(ctx, "approval");
        await wait(trace, interaction);
        await session.close();
        await wait(trace, (e) => e.t === "interaction.cleared");
        break;
      case "host_tools":
        await send(ctx, "host_tools");
        await wait(trace, done);
        check(
          trace.some(
            (e) => e.t === "tool.done" && JSON.stringify(e.output).includes("scoped-host-ok"),
          ),
          "host tool authentication failed",
        );
        break;
      case "environment":
        check(
          !("ZOLTBOT_UNLISTED_SECRET" in (await ctx.childEnvironment())),
          "inherited unlisted environment variable",
        );
        break;
      case "background": {
        // Fixture input "background": one background shell task, stoppable between turns.
        if (!session.capabilities.backgroundTasks) break;
        check(session.stopBackground, "advertised background tasks without stopBackground");
        await send(ctx, "background");
        const reported = await wait(
          trace,
          (e) => e.t === "background.updated" && e.task.state === "running",
        );
        check(reported.t === "background.updated", "background task missing");
        await wait(trace, done);
        const tool = trace.find(
          (e) => e.t === "tool.started" && e.itemId === reported.task.toolItemId,
        );
        check(
          !reported.task.toolItemId || tool,
          "background task links a tool item that never started",
        );
        await session.stopBackground(reported.task.id);
        await wait(
          trace,
          (e) =>
            e.t === "background.updated" &&
            e.task.id === reported.task.id &&
            e.task.state !== "running",
        );
        break;
      }
      case "rewind": {
        if (!session.capabilities.rewind) break;
        check(session.rewindFiles, "advertised rewind without rewindFiles");
        await send(ctx, "normal");
        const started = await wait(trace, (e) => e.t === "turn.started");
        await wait(trace, done);
        check(started.t === "turn.started", "turn missing");
        const preview = await session.rewindFiles(started.turnId, true);
        check(
          typeof preview.canRewind === "boolean" &&
            Array.isArray(preview.files) &&
            preview.files.every((file) => typeof file === "string"),
          "rewind preview shape",
        );
        break;
      }
      case "frame_log":
        await send(ctx, "secret_frames");
        await wait(trace, done);
        check(!(await ctx.frameLog()).includes("seeded-secret"), "frame log exposed a secret");
        check((await ctx.frameLog()).length > 0, "frame log missing");
        break;
    }
    for (const event of trace) parse(AgentEventSchema, event);
    check(
      trace.every((e) => e.t !== "tool.started" || !e.title?.includes("\n")),
      "tool titles must be one line",
    );
  } catch (error) {
    throw new Error(
      `${scenario}: ${error instanceof Error ? error.message : "failed"}\nFrames: ${(await ctx.frameLog()).slice(-12000)}`,
    );
  } finally {
    await ctx.dispose();
  }
}
