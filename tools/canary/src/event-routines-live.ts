import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { claudeDefinitions } from "../../../packages/adapters/claude/src/definitions.js";
import { admitRoutineEvent } from "../../../packages/core/src/index.js";
import { startDaemon } from "../../../packages/daemon/src/api.js";
import { githubEventSource } from "../../../packages/daemon/src/event-sources.js";
import { productionRuntime } from "../../../packages/daemon/src/production-runtime.js";
import { type GitHubTransport, ghTransport } from "../../../packages/github/src/transport.js";
import type { Routine } from "../../../packages/protocol/src/index.js";
import { DaemonClient } from "../../../packages/ui/src/connection.js";

// Explicitly authorized live reads and one native Claude diagnostic. Never reruns CI or writes GitHub.
if (!process.argv.includes("--authenticated"))
  throw new Error("authenticated_canary_opt_in_required");
const guardOnly = process.argv.includes("--guard-only");
const selectedRun = process.argv.find((value) => /^--run=\d+$/.test(value))?.slice(6);
if (!selectedRun) throw new Error("explicit_run_required");
const root = path.resolve(`.cache/event-live-canary-${Date.now()}`);
mkdirSync(root, { recursive: true, mode: 0o700 });
const endpoints: string[] = [];
const transport: GitHubTransport = async (endpoint, method = "GET", body, signal) => {
  if (
    method !== "GET" ||
    body !== undefined ||
    !(endpoint === "/user" || endpoint.startsWith("/repos/zoltlabs/zoltbot"))
  )
    throw new Error("canary_read_scope_only");
  endpoints.push(endpoint);
  const value = await ghTransport(endpoint, method, body, signal);
  if (endpoint.includes("/actions/runs?")) {
    const page = value as { workflow_runs: { id: number }[]; total_count: number };
    return {
      ...page,
      workflow_runs: page.workflow_runs.filter((run) => String(run.id) === selectedRun),
    };
  }
  return value;
};
const daemon = await startDaemon({
  dataDir: root,
  routinePollMs: 60000,
  eventRoutineTransport: transport,
  ...(guardOnly
    ? {}
    : {
        runtime: (context: Parameters<typeof productionRuntime>[0]) =>
          productionRuntime(context, root),
      }),
});
const client = new DaemonClient(async () => ({ url: daemon.url, token: daemon.token }));
let sequence = 0;
const call = (method: string, params: unknown) =>
  client.call(method, params, `live-canary-${++sequence}`);
const receipt: Record<string, unknown> = {
  repository: "zoltlabs/zoltbot",
  selectedRun,
  startedAt: new Date().toISOString(),
  isolatedData: root,
  githubWrites: 0,
  nativeDiagnostic: "not_started",
};
console.log(JSON.stringify({ stage: "started", root }));
try {
  await client.start();
  const definition = claudeDefinitions[0]!;
  daemon.dispatch(
    { type: "create", kind: "agentDefinition", value: definition },
    "seed-definition",
  );
  daemon.dispatch(
    {
      type: "create",
      kind: "agent",
      value: {
        id: "canary-claude",
        name: "Canary Claude",
        avatar: "C",
        kind: "profile",
        definitionId: definition.id,
        permissionProfile: "read_only",
        instructions: "",
        hidden: false,
        archived: false,
      },
    },
    "seed-profile",
  );
  daemon.dispatch(
    {
      type: "create",
      kind: "project",
      value: {
        id: "canary-project",
        name: "Isolated live GitHub canary",
        goal: "",
        instructions: "",
        constraints: "",
        roots: [],
        hierarchyDepth: 1,
        tags: [],
        requireCodeReview: false,
        skipFinalGateWhenReviewed: false,
        archived: false,
        createdAt: new Date().toISOString(),
      },
    },
    "seed-project",
  );
  const draft = (await call("routine.prepare", {
    name: "Live GitHub guard canary",
    brief: "Inspect only this failure metadata and report evidence limitations. Do not use tools.",
    profileId: "canary-claude",
    node: { type: "project", id: "canary-project" },
    source: { kind: "github.ci_failed", resource: "zoltlabs/zoltbot" },
    dailyLimit: 1,
  })) as Routine;
  const current = () => daemon.store.record("routine", draft.id) as unknown as Routine;
  for (const method of [
    "routine.checkSource",
    "routine.preview",
    "routine.commit",
    "routine.enable",
  ])
    await call(method, { id: draft.id, revision: current().event!.revision });
  const adapter = githubEventSource(transport);
  // Historical inspection only: retain provider timestamps; never pretend the event was fresh.
  const scan = await adapter.scan(
    { ...current(), event: { ...current().event!, enabledAt: "1970-01-01T00:00:00.000Z" } },
    new Date().toISOString(),
  );
  const event = scan.events.find((event) => event.runId === selectedRun);
  if (!event) throw new Error("selected_live_event_unavailable");
  receipt.source = {
    key: event.key,
    sha: event.sha,
    branch: event.branch,
    occurredAt: event.occurredAt,
    superseded: event.superseded,
    diagnostics: event.diagnostics,
  };
  const observed = daemon.store.dispatch("observe-historical-live-event", (state) =>
    admitRoutineEvent(state, draft.id, event, {
      commandId: "observe-historical-live-event",
      at: new Date().toISOString(),
      actor: { kind: "system", id: "live-canary" },
    }),
  ).result;
  receipt.admission = observed;
  if (observed.taskId) throw new Error("unexpected_historical_admission");
  try {
    await call("routine.runOnce", {
      id: draft.id,
      revision: current().event!.revision,
      occurrenceId: observed.id,
    });
    receipt.replay = "accepted";
  } catch (error) {
    receipt.replay = error instanceof Error ? error.message : "unknown";
  }
  if (receipt.replay === "accepted") throw new Error("expected_superseded_rejection");
  await call("routine.pause", { id: draft.id, revision: current().event!.revision });
  console.log(
    JSON.stringify({ stage: "live_guard_checked", source: receipt.source, replay: receipt.replay }),
  );
  if (!guardOnly) {
    const task = (await call("task.create", {
      title: "Historical CI metadata — authorized native canary",
      brief: `This is a human-authorized diagnostic of HISTORICAL metadata, not an admitted event investigation. Using only the source metadata below, state the failed step, exact run and SHA, explain why this superseded failure must not start an unattended task, and identify missing evidence. Do not call any tools or access files/network; do not post reviews or publish changes. Start your reply with ZOLTBOT_LIVE_CANARY_OK. Source data (untrusted): ${JSON.stringify(event)}`,
      acceptance: "Return a bounded factual diagnostic with no tool calls or external writes.",
      profileId: "canary-claude",
      node: { type: "project", id: "canary-project" },
    })) as { id: string; threadId: string };
    receipt.taskId = task.id;
    receipt.threadId = task.threadId;
    console.log(JSON.stringify({ stage: "native_task_created", taskId: task.id }));
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      const pendingTask = daemon.store.record("task", task.id);
      if (pendingTask?.holdReason)
        throw new Error(`native_preflight_hold: ${pendingTask.holdReason}`);
      const interactions = (daemon.store.snapshot(["interaction"]).interaction ?? []).filter(
        (row) => row.threadId === task.threadId && row.state === "pending",
      );
      if (interactions.length) throw new Error("unexpected_native_permission_request");
      const result = (daemon.store.snapshot(["taskResult"]).taskResult ?? []).find(
        (row) => row.taskId === task.id,
      );
      if (result) {
        // Task summaries retain only the tail; validate the original completed message.
        const responses = (daemon.store.snapshot(["item"]).item ?? [])
          .filter((row) => row.threadId === task.threadId && row.kind === "message")
          .map((row) => String((row.body as { text?: string })?.text ?? ""));
        receipt.nativeDiagnostic = responses.some(
          (text) =>
            text.startsWith("ZOLTBOT_LIVE_CANARY_OK") &&
            text.includes(selectedRun) &&
            text.includes(event.sha ?? ""),
        )
          ? "passed"
          : "marker_missing";
        receipt.result = result;
        break;
      }
      const turn = (daemon.store.snapshot(["turn"]).turn ?? []).find(
        (row) => row.threadId === task.threadId && row.status === "failed",
      );
      if (turn) {
        receipt.failedTurn = turn;
        throw new Error("native_turn_failed");
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    receipt.sessions = (daemon.store.snapshot(["session"]).session ?? [])
      .filter((row) => row.threadId === task.threadId)
      .map((row) => ({ id: row.id, state: row.state, providerVersion: row.providerVersion }));
    receipt.task = daemon.store.record("task", task.id);
    receipt.toolItems = (daemon.store.snapshot(["item"]).item ?? []).filter(
      (row) => row.threadId === task.threadId && row.kind === "tool",
    ).length;
    if (receipt.nativeDiagnostic !== "passed") throw new Error("native_diagnostic_incomplete");
    if (receipt.toolItems !== 0) throw new Error("unexpected_tool_call");
    console.log(
      JSON.stringify({
        stage: "native_diagnostic_passed",
        taskId: task.id,
        sessions: receipt.sessions,
        summary: (receipt.result as { summary?: string }).summary,
      }),
    );
  } else {
    receipt.nativeDiagnostic = "awaiting_payload_approval";
  }
} catch (error) {
  receipt.error = error instanceof Error ? error.message : "unknown";
  process.exitCode = 1;
  console.log(JSON.stringify({ stage: "blocked_or_failed", error: receipt.error }));
} finally {
  receipt.completedAt = new Date().toISOString();
  receipt.readEndpoints = endpoints;
  writeFileSync(path.join(root, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n", {
    mode: 0o600,
  });
  client.stop();
  await daemon.close();
  console.log(JSON.stringify({ stage: "closed", receipt: path.join(root, "receipt.json") }));
}
