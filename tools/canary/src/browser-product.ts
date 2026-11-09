import type { BrowserEvidence } from "../../../packages/daemon/src/browser/evidence.js";
import type { BrowserBinding } from "../../../packages/protocol/src/index.js";

interface View {
  binding: BrowserBinding | null;
  evidence: (BrowserEvidence & { observed: boolean })[];
}
interface CanaryTask {
  id: string;
  provider: string;
  index: number;
  url: string;
  expected?: string;
  pixelAnswerMatched?: boolean;
  evidence?: View["evidence"];
  binding?: BrowserBinding | null;
  nativeId?: unknown;
}
interface Receipt {
  routine?: {
    id: string;
    taskId: string;
    freshBinding: boolean;
    background: boolean;
    pixelsMatched: boolean;
  };
  startedAt: string;
  tasks: CanaryTask[];
  passed?: boolean;
  error?: string;
  lifecycle?: {
    generationBefore: number;
    generationAfter: number;
    siblingUnaffected: boolean;
    formNotReplayed: boolean;
  };
  resume?: { sameBinding: boolean; sameNativeId: boolean; revisions: number[] };
}

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import type { createServer } from "node:http";
import path from "node:path";
import WebSocket from "ws";
import { claudeDefinitions } from "../../../packages/adapters/claude/src/definitions.js";
import { codexDefinitions } from "../../../packages/adapters/codex/src/definitions.js";
import { startDaemon } from "../../../packages/daemon/src/api.js";
import { browserCommand, browserReadiness } from "../../../packages/daemon/src/browser/runtime.js";
import { Redactor } from "../../../packages/daemon/src/logging.js";
import { productionRuntime } from "../../../packages/daemon/src/production-runtime.js";
import { browserFixture } from "./browser-fixture.js";

// Explicit opt-in acceptance, local fixtures and fake form data only. Uses normal native auth.
const root = path.resolve(`.cache/browser-product-canary-${Date.now()}`);
mkdirSync(path.join(root, "browser"), { recursive: true });
if (!existsSync(path.join(root, "browser", "browsers")))
  symlinkSync(
    path.resolve(".cache/browser-spike/browsers"),
    path.join(root, "browser", "browsers"),
  );
if ((await browserReadiness(root)).state !== "ready") throw Error("pinned_browser_not_ready");
let clock = new Date().toISOString();
let daemon = await startDaemon({
  routineClock: () => clock,
  routinePollMs: 100,
  dataDir: root,
  runtime: (context) => productionRuntime(context, root),
});
const servers: ReturnType<typeof createServer>[] = [];
let socket: WebSocket | undefined;
let sequence = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
async function connect() {
  socket = new WebSocket(daemon.url);
  socket.on("message", (raw) => {
    const data = JSON.parse(raw.toString());
    const p = pending.get(data.id);
    if (p) {
      pending.delete(data.id);
      if (data.error) p.reject(Error(data.error.message));
      else p.resolve(data.result);
    }
  });
  await new Promise<void>((r, j) => {
    socket?.once("open", r);
    socket?.once("error", j);
  });
  await call("hello", { protocolVersion: 1, token: daemon.token });
}
function call<T = unknown>(method: string, params: unknown) {
  const id = ++sequence;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: (value) => resolve(value as T), reject });
    if (!socket) throw Error("canary_socket_missing");
    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        params,
        ...(method === "hello" ? {} : { commandId: `browser-canary-${Date.now()}-${id}` }),
      }),
    );
  });
}
const expectedMarkers = new Map<string, string>();
const receipt: Receipt = { startedAt: new Date().toISOString(), tasks: [] };
try {
  await connect();
  const at = new Date().toISOString();
  for (const definition of [...claudeDefinitions, ...codexDefinitions]) {
    daemon.dispatch(
      { type: "create", kind: "agentDefinition", value: definition },
      `seed-${definition.id}`,
    );
    daemon.dispatch(
      {
        type: "create",
        kind: "agent",
        value: {
          id: definition.id,
          name: definition.displayName,
          avatar: "B",
          kind: "profile",
          definitionId: definition.id,
          permissionProfile: "workspace_write",
          instructions: "",
          hidden: false,
          archived: false,
        },
      },
      `profile-${definition.id}`,
    );
  }
  daemon.dispatch(
    {
      type: "create",
      kind: "project",
      value: {
        id: "browser-project",
        name: "Browser canary",
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
    },
    "seed-project",
  );
  for (const [index, provider] of ["claude", "codex", "codex"].entries()) {
    const fixture = await browserFixture(index);
    const { expected, url, server } = fixture;
    servers.push(server);
    const task = await call<{ id: string }>("task.create", {
      title: `Browser ${provider} ${index}`,
      brief:
        "Use the assigned local browser and its supplied launcher. Snapshot, fill Alias with fake-test, click Submit, capture a PNG, register it using team_browser_evidence, then inspect the returned canonicalPath with your native image tool. Report the visual digits and whether Submitted appears. The digits are pixels, absent from DOM text. Do not use eval/run-code to extract them, inspect other files, or visit external sites. All accounts and data here are fake.",
      profileId: provider,
      node: { type: "project", id: "browser-project" },
      browser: { mode: "background", url },
    });
    expectedMarkers.set(task.id, expected);
    receipt.tasks.push({ id: task.id, provider, index, url, expected });
  }
  const answered = new Set<string>();
  async function settle(ids: string[], timeout = 300000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      for (const i of daemon.store.snapshot(["interaction"]).interaction ?? [])
        if (i.state === "pending" && !answered.has(String(i.id))) {
          answered.add(String(i.id));
          if (
            i.type !== "approval" &&
            !(i.type === "form" && String(i.title).includes("team_browser_evidence"))
          )
            throw Error("unexpected_interactive_request");
          await call("interaction.answer", {
            id: i.id,
            version: i.version,
            answer: {
              action: "accept",
              ...(i.type === "form"
                ? { answers: { form: { value: {} } } }
                : { choice: "allow_once" }),
              by: { kind: "human", id: "browser-canary" },
              at: new Date().toISOString(),
            },
          });
        }
      const tasks = ids.map((id) => daemon.store.record("task", id));
      if (tasks.every((t) => t?.state === "review")) return;
      if (daemon.logger.lines.some((line) => line.includes("runtime_event_failed")))
        throw Error("native_resume_event_failed");
      if (tasks.some((t) => t?.state === "failed"))
        throw Error(
          `native_task_failed:${JSON.stringify(tasks.map((t) => ({ state: t?.state, hold: t?.holdReason })))}`,
        );
      await new Promise((r) => setTimeout(r, 200));
    }
    throw Error("canary_timeout");
  }
  await settle(receipt.tasks.map((t) => t.id));
  for (const task of receipt.tasks) {
    const state = await call<View>("browser.task", { id: task.id });
    const result = daemon.store
      .snapshot(["taskResult"])
      .taskResult?.find((r) => r.taskId === task.id);
    task.pixelAnswerMatched = String(result?.summary).includes(
      task.expected ?? "MISSING_EXPECTED_MARKER",
    );
    task.evidence = state.evidence;
    task.binding = state.binding;
    task.nativeId = daemon.store
      .snapshot(["session"])
      .session?.find(
        (s) => s.threadId === daemon.store.record("task", task.id)?.threadId,
      )?.nativeId;
    for (const evidence of state.evidence) {
      const response = await fetch(
        `${daemon.url.replace("ws:", "http:")}/browser-evidence/${evidence.id}`,
        { headers: { Authorization: `Bearer ${daemon.token}` } },
      );
      const bytes = Buffer.from(await response.arrayBuffer());
      if (createHash("sha256").update(bytes).digest("hex") !== evidence.hash)
        throw Error("human_asset_hash_mismatch");
    }
    if (!task.pixelAnswerMatched || !state.evidence.length)
      throw Error("pixel_or_registration_failed");
    delete task.expected;
  }
  const manual = receipt.tasks[0];
  if (!manual?.binding) throw Error("missing_routine_source");
  const routine = await call<{ id: string; nextRunAt: string }>("routine.create", {
    taskId: manual.id,
    name: "Browser canary routine",
    schedule: { cron: "@every 1m", timezone: "UTC" },
    permissionCeiling: "workspace_write",
    notify: "actionable_only",
  });
  clock = routine.nextRunAt;
  let runId: string | undefined;
  const fireDeadline = Date.now() + 5000;
  while (!runId && Date.now() < fireDeadline) {
    runId = daemon.store
      .snapshot(["routineOccurrence"])
      .routineOccurrence?.find((o) => o.routineId === routine.id)?.taskId as string | undefined;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!runId) throw Error("routine_not_dispatched");
  const currentRoutine = daemon.store.record("routine", routine.id);
  await call("routine.update", {
    id: routine.id,
    expectedUpdatedAt: currentRoutine?.updatedAt,
    paused: true,
  });
  await settle([runId]);
  const routineView = await call<View>("browser.task", { id: runId });
  const routineResult = daemon.store
    .snapshot(["taskResult"])
    .taskResult?.find((r) => r.taskId === runId);
  const routinePixels = String(routineResult?.summary).includes(
    expectedMarkers.get(manual.id) ?? "MISSING_MARKER",
  );
  if (
    !routinePixels ||
    !routineView.evidence.length ||
    routineView.binding?.id === manual.binding.id ||
    routineView.binding?.mode !== "background"
  )
    throw Error("routine_browser_acceptance_failed");
  receipt.routine = {
    id: routine.id,
    taskId: runId,
    freshBinding: true,
    background: true,
    pixelsMatched: true,
  };
  receipt.tasks.push({
    id: runId,
    provider: "claude",
    index: 3,
    url: manual.url,
    pixelAnswerMatched: true,
    binding: routineView.binding,
    evidence: routineView.evidence,
  });
  // A process replacement retains exact native conversation and launch binding.
  socket?.terminate();
  await daemon.close();
  daemon = await startDaemon({
    routineClock: () => clock,
    routinePollMs: 100,
    dataDir: root,
    runtime: (context) => productionRuntime(context, root),
  });
  await connect();
  const revised = receipt.tasks[1];
  if (!revised?.binding) throw Error("missing_revised_binding");
  await call("task.review", {
    id: revised.id,
    revision: 1,
    decision: "changes",
    feedback:
      "Reply with exactly the digits you saw previously. Do not use tools or visit the page again.",
    confirmed: true,
  });
  await settle([revised.id]);
  const after = await call<View>("browser.task", { id: revised.id });
  if (after.binding?.id !== revised.binding.id) throw Error("resume_binding_changed");
  const sessions = daemon.store
    .snapshot(["session"])
    .session?.filter((s) => s.threadId === daemon.store.record("task", revised.id)?.threadId);
  if (sessions?.some((s) => s.nativeId !== revised.nativeId))
    throw Error("native_conversation_changed");
  receipt.resume = {
    sameBinding: true,
    sameNativeId: true,
    revisions:
      daemon.store
        .snapshot(["taskResult"])
        .taskResult?.filter((r) => r.taskId === revised.id)
        .map((r) => Number(r.revision)) ?? [],
  };
  const selected = receipt.tasks[0];
  const sibling = receipt.tasks[2];
  if (!selected?.binding || !sibling) throw Error("missing_lifecycle_tasks");
  const beforeGeneration = selected.evidence?.[0]?.generation ?? 0;
  const reopened = await call<{ generation: number }>("browser.action", {
    id: selected.id,
    action: "reopen_visible",
    confirmed: true,
    url: selected.url,
  });
  const freshSnapshot = await browserCommand(selected.binding, ["snapshot"]);
  if (reopened.generation <= beforeGeneration || freshSnapshot.includes("Submitted"))
    throw Error("browser_generation_or_replay_failed");
  await call("browser.action", { id: selected.id, action: "stop", confirmed: true });
  const siblingState = await call<View & { health: string }>("browser.task", { id: sibling.id });
  if (siblingState.health !== "running") throw Error("sibling_browser_closed");
  receipt.lifecycle = {
    generationBefore: beforeGeneration,
    generationAfter: reopened.generation,
    siblingUnaffected: true,
    formNotReplayed: true,
  };
  receipt.passed = true;
} catch (error) {
  receipt.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  for (const task of receipt.tasks)
    await call("browser.action", { id: task.id, action: "stop", confirmed: true }).catch(() => {});
  socket?.terminate();
  await daemon.close();
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
  for (const task of receipt.tasks) delete task.expected;
  writeFileSync(path.resolve(".cache/browser-product-last.json"), JSON.stringify({ root }));
  writeFileSync(
    path.join(root, "receipt.json"),
    JSON.stringify(new Redactor().value(receipt), null, 2),
  );
  console.log(
    JSON.stringify({
      passed: receipt.passed ?? false,
      error: receipt.error,
      tasks: receipt.tasks.map((t) => ({
        provider: t.provider,
        pixels: t.pixelAnswerMatched,
        captures: t.evidence?.length,
      })),
    }),
  );
}
