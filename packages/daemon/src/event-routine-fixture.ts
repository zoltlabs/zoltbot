import { type CommandContext, type DomainState, handle, type Outcome } from "@zoltbot/core";
import type { EventRoutineInput, Routine } from "@zoltbot/protocol";
import { runtimeFixture } from "../../../tools/fakes/src/runtime-fixture.js";
import { eventRoutines } from "./event-routines.js";
export async function fixture() {
  const f = await runtimeFixture();
  let now = "2026-11-06T12:00:00.000Z";
  let account = 42,
    attempt = 1,
    conclusion = "failure";
  let calls = 0;
  let crashAdmission = false;
  const run = (id: string, work: (state: DomainState, context: CommandContext) => Outcome) => {
    const crash = crashAdmission && id.startsWith("event-admit:");
    if (crash) crashAdmission = false;
    return f.store.dispatch(
      id,
      (state) =>
        work(state, { commandId: id, at: now, actor: { kind: "system", id: "event-executor" } }),
      crash ? { killPoint: "after_projections" } : {},
    ).result;
  };
  run("adapter", (s, c) =>
    handle(
      s,
      { type: "update", kind: "agentDefinition", id: "fake", changes: { adapter: "claude" } },
      c,
    ),
  );
  run("project", (s, c) =>
    handle(
      s,
      {
        type: "create",
        kind: "project",
        value: {
          id: "p",
          name: "Fixture",
          goal: "",
          instructions: "",
          constraints: "",
          roots: [],
          hierarchyDepth: 1,
          tags: [],
          requireCodeReview: false,
          skipFinalGateWhenReviewed: false,
          archived: false,
          createdAt: now,
        },
      },
      c,
    ),
  );
  const workflow = () => ({
    id: 99,
    workflow_id: 3,
    run_attempt: attempt,
    head_sha: "a".repeat(40),
    head_branch: "main",
    updated_at: "2026-11-06T12:00:30.000Z",
    status: "completed",
    conclusion,
  });
  const service = () =>
    eventRoutines({
      store: f.store,
      run,
      now: () => now,
      transport: async (endpoint) => {
        calls++;
        if (endpoint === "/user") return { id: account };
        if (endpoint === "/repos/example/app") return { id: 7, full_name: "example/app" };
        if (endpoint.includes("/branches/")) return { commit: { sha: "a".repeat(40) } };
        if (endpoint.includes("/jobs?"))
          return {
            jobs: [
              {
                name: "test",
                conclusion: "failure",
                steps: [{ name: "Assertions", conclusion: "failure" }],
              },
            ],
          };
        if (endpoint.includes("?status")) return { total_count: 1, workflow_runs: [workflow()] };
        if (endpoint.endsWith("/99")) return workflow();
        throw new Error("unexpected_endpoint");
      },
    });
  const input: EventRoutineInput = {
    name: "Diagnose",
    brief: "Inspect failure",
    profileId: "profile",
    node: { type: "project", id: "p" },
    source: { kind: "github.ci_failed", resource: "example/app", branch: "main" },
  };
  const api = service();
  const prepare = () => api.api("routine.prepare", input, "prepare") as Promise<Routine>;
  const cmd = (method: string, r: Routine, key = method) =>
    api.api(
      method,
      {
        id: r.id,
        revision: (f.store.record("routine", r.id)?.event as Routine["event"])?.revision,
      },
      key,
    );
  const enable = async () => {
    const r = await prepare();
    await cmd("routine.checkSource", r);
    await cmd("routine.preview", r);
    await cmd("routine.commit", r);
    await cmd("routine.enable", r);
    return r;
  };
  return {
    ...f,
    run,
    api,
    service,
    input,
    prepare,
    cmd,
    enable,
    calls: () => calls,
    crashNextAdmission: () => {
      crashAdmission = true;
    },
    setNow: (value: string) => {
      now = value;
    },
    setAccount: (value: number) => {
      account = value;
    },
    setAttempt: (value: number) => {
      attempt = value;
    },
    setConclusion: (value: string) => {
      conclusion = value;
    },
  };
}
