import type { CellTokenClaims } from "@zoltbot/cloud-contracts";
import { type CommandContext, createTask, handle } from "@zoltbot/core";
import {
  type DomainEvent,
  type InteractionAnswer,
  InteractionSchema,
  ProjectSchema,
  parse,
} from "@zoltbot/protocol";
import type { MacExecRequest } from "@zoltbot/runner-protocol";
import { migrateDriver, Store } from "@zoltbot/store/portable";
import { afterEach, expect, it, vi } from "vitest";
import { SqliteDriver } from "../../store/src/sqlite-driver.js";
import { CellAnswers } from "./answers.js";
import { CloudRpc } from "./cloud-rpc.js";
import { CellLeases } from "./leases.js";
import { CellMacRecords } from "./mac-records.js";
import { runnerEvent } from "./runner-events.js";
import { seedCell } from "./seed.js";
import { CellService } from "./service.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});
function fixture() {
  const database = new SqliteDriver(":memory:");
  migrateDriver(database);
  const store = new Store(database);
  cleanup.push(() => store.close());
  seedCell(store);
  const now = Date.now(),
    at = new Date(now).toISOString();
  const context = (commandId: string): CommandContext => ({
    commandId,
    at,
    actor: { kind: "human", id: "member" },
  });
  store.dispatch("project", (state) =>
    handle(
      state,
      {
        type: "create",
        kind: "project",
        value: parse(ProjectSchema, {
          id: "project",
          name: "Project",
          goal: "",
          instructions: "",
          constraints: "",
          roots: [],
          hierarchyDepth: 0,
          tags: [],
          requireCodeReview: false,
          skipFinalGateWhenReviewed: false,
          archived: false,
          createdAt: at,
          cloud: { repository: "example/repo", defaultBranch: "main", setupScript: "" },
        }),
      },
      context("project"),
    ),
  );
  store.dispatch("task", (state) => {
    const result = createTask(
      state,
      {
        id: "task",
        title: "Task",
        brief: "Work",
        profileId: "cloud-claude",
        node: { type: "project", id: "project" },
      },
      context("task"),
    );
    return {
      ...result,
      events: result.events.map((event) =>
        event.aggregateType === "task"
          ? {
              ...event,
              payload: {
                ...(event.payload as object),
                state: "running",
                location: "sandbox",
                executionLocation: "sandbox",
              },
            }
          : event,
      ),
    };
  });
  const threadId = String(store.record("task", "task")?.threadId);
  for (const [kind, value] of [
    [
      "session",
      {
        id: "session",
        threadId,
        provider: "claude",
        nativeId: "native",
        cwd: "/work",
        state: "starting",
        capabilities: {},
        startedAt: at,
      },
    ],
    [
      "turn",
      {
        id: "turn",
        threadId,
        sessionId: "session",
        status: "running",
        origin: "human",
        startedAt: at,
      },
    ],
  ] as const) {
    store.dispatch(kind, (state) => handle(state, { type: "create", kind, value }, context(kind)));
    if (kind === "session")
      for (const to of ["ready", "running"]) {
        const id = `session-${to}`;
        store.dispatch(id, (state) =>
          handle(state, { type: "transition", kind: "session", id: "session", to }, context(id)),
        );
      }
  }
  const claims: CellTokenClaims = {
    iss: "https://accounts.example.invalid",
    aud: "cell",
    iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + 600,
    jti: "token",
    org: "org",
    sub: "member",
    device: "worker",
    kind: "sandbox_runner",
    surface: "runner",
    task: "task",
  };
  const records = new CellMacRecords(store, { orgId: "org", userId: "member" }, () => now);
  const leases = new CellLeases(store),
    lease = leases.assign("task", "worker", claims, now);
  leases.heartbeat("worker", [lease.leaseId], claims, now, "connection");
  database.prepare("INSERT INTO cell_runner_connections VALUES(?,?)").run("worker", "connection");
  const source = { claims, connectionId: "connection" },
    mac = { deviceId: "mac", mac: "Test Mac", cwd: "/home/user/work" };
  const request: MacExecRequest = {
    requestId: "request",
    taskId: "task",
    turnId: "turn",
    userId: "member",
    targetDeviceId: "mac",
    cwd: mac.cwd,
    command: "uname",
  };
  const client: CellTokenClaims = {
    ...claims,
    kind: "client",
    device: "phone",
    surface: "phone",
    session: "account-session",
  };
  delete client.task;
  const answer = (id: string): InteractionAnswer => {
    const interaction = parse(InteractionSchema, store.record("interaction", id)),
      draft = interaction.context?.macExec;
    if (!draft) throw new Error("fixture_draft_missing");
    return {
      action: "accept",
      choice: "allow_once",
      by: { kind: "human", id: "member" },
      at,
      signedApproval: {
        payload: { ...draft, signerDeviceId: "phone", issuedAt: now, expiresAt: now + 300000 },
        signature: "A".repeat(86),
      },
    };
  };
  const resolve = (id: string, resolution: InteractionAnswer, principal = client) =>
    store.dispatch(`answer:${id}`, (state) => {
      const interaction = parse(InteractionSchema, store.record("interaction", id));
      const ctx = context(`answer:${id}`),
        output = handle(state, { type: "answer", id, version: 1, answer: resolution }, ctx);
      const audit: DomainEvent[] = records.resolve(interaction, resolution, principal, ctx);
      return { ...output, events: [...output.events, ...audit] };
    });
  return { store, database, now, records, source, mac, request, client, answer, resolve };
}
it("commits one scoped approval interaction and survives a new records instance without duplicates", async () => {
  const f = fixture();
  vi.spyOn(f.store, "snapshot").mockImplementation(() => {
    throw new Error("whole_cell_read_forbidden");
  });
  const [first, concurrent] = await Promise.all([
    f.records.request(f.source, f.request, f.mac),
    f.records.request(f.source, f.request, f.mac),
  ]);
  expect(concurrent).toEqual(first);
  expect(first.state).toBe("pending");
  expect(await f.records.request(f.source, f.request, f.mac)).toEqual(first);
  const reopened = new CellMacRecords(f.store, { orgId: "org", userId: "member" }, () => f.now);
  expect(await reopened.request(f.source, f.request, f.mac)).toEqual(first);
  expect(
    (f.database.prepare("SELECT count(*) AS n FROM cell_mac_requests").get() as { n: number }).n,
  ).toBe(1);
  if (first.state !== "pending") throw new Error("fixture_pending_missing");
  const interaction = parse(InteractionSchema, f.store.record("interaction", first.interactionId));
  expect(interaction.context?.macExec?.stdinHash).toHaveLength(43);
  expect(f.records.has(first.interactionId)).toBe(true);
  await expect(
    f.records.request(f.source, { ...f.request, command: "false" }, f.mac),
  ).rejects.toThrow("command_conflict");
});
it("refuses cross-org/member/task, stale connection and caller-supplied approvals", async () => {
  const f = fixture();
  for (const claims of [
    { ...f.source.claims, org: "other" },
    { ...f.source.claims, sub: "other" },
    { ...f.source.claims, task: "other" },
  ])
    await expect(f.records.request({ ...f.source, claims }, f.request, f.mac)).rejects.toThrow(
      "forbidden",
    );
  await expect(
    f.records.request({ ...f.source, connectionId: "old" }, f.request, f.mac),
  ).rejects.toThrow("forbidden");
  await expect(
    f.records.request(f.source, { ...f.request, taskId: "other" }, f.mac),
  ).rejects.toThrow("forbidden");
  const pending = await f.records.request(f.source, f.request, f.mac);
  if (pending.state !== "pending") throw new Error("fixture_pending_missing");
  const approval = f.answer(pending.interactionId).signedApproval;
  if (!approval) throw new Error("fixture_approval_missing");
  await expect(f.records.request(f.source, { ...f.request, approval }, f.mac)).rejects.toThrow(
    "forbidden",
  );
  f.database.prepare("UPDATE cell_runner_connections SET connection_id='new'").run();
  await expect(f.records.request(f.source, f.request, f.mac)).rejects.toThrow("forbidden");
});
it("keeps core resolution and approval state atomic and requires the authenticated signing device", async () => {
  const f = fixture(),
    pending = await f.records.request(f.source, f.request, f.mac);
  if (pending.state !== "pending") throw new Error("fixture_pending_missing");
  const answer = f.answer(pending.interactionId);
  if (!answer.signedApproval) throw new Error("fixture_approval_missing");
  answer.signedApproval.payload.command = "false";
  expect(() => f.resolve(pending.interactionId, answer)).toThrow("forbidden");
  expect(f.store.record("interaction", pending.interactionId)?.state).toBe("pending");
  expect((await f.records.request(f.source, f.request, f.mac)).state).toBe("pending");
  expect(() =>
    f.resolve(pending.interactionId, f.answer(pending.interactionId), {
      ...f.client,
      device: "other",
    }),
  ).toThrow("forbidden");
  f.resolve(pending.interactionId, f.answer(pending.interactionId));
  expect((await f.records.request(f.source, f.request, f.mac)).state).toBe("running");
});
it("accepts one result only from the target Mac and audits metadata without output", async () => {
  const f = fixture(),
    pending = await f.records.request(f.source, f.request, f.mac);
  if (pending.state !== "pending") throw new Error("fixture_pending_missing");
  f.resolve(pending.interactionId, f.answer(pending.interactionId));
  const macClaims: CellTokenClaims = {
    ...f.source.claims,
    kind: "mac_runner",
    device: "mac",
    session: "mac-session",
    grant: "grant",
  };
  delete macClaims.task;
  const result = {
    requestId: "request",
    taskId: "task",
    exitCode: 0,
    stdout: "unique-output-marker",
    stderr: "",
    durationMs: 5,
    truncated: false,
    mac: "Test Mac",
  };
  expect(() => f.records.finish({ ...macClaims, device: "other" }, result)).toThrow("forbidden");
  expect(() => f.records.finish(f.source.claims, result)).toThrow("forbidden");
  f.records.finish(macClaims, result);
  f.records.finish(macClaims, result);
  expect(await f.records.request(f.source, f.request, f.mac)).toEqual({
    state: "complete",
    requestId: "request",
    result,
  });
  expect(() => f.records.finish(macClaims, { ...result, exitCode: 1 })).toThrow("command_conflict");
  const audit = f.store.read({ taskId: "task" }, ["audit"]).audit ?? [];
  expect(JSON.stringify(audit).includes(result.stdout)).toBe(false);
});
it.each([
  "interaction.answer",
  "interaction.batchAnswer",
])("routes %s to the Cell-owned approval without a native answer", async (method) => {
  const f = fixture(),
    pending = await f.records.request(f.source, f.request, f.mac);
  if (pending.state !== "pending") throw new Error("fixture_pending_missing");
  const answers = new CellAnswers(f.store),
    prepare = vi.spyOn(answers, "prepare");
  const service = new CellService(
    {
      origin: "https://accounts.example.invalid",
      issuer: "https://accounts.example.invalid",
      signingKey: btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/, ""),
    },
    "org",
  );
  const rpc = new CloudRpc(f.store, f.client, service, answers);
  const item = { id: pending.interactionId, version: 1, answer: f.answer(pending.interactionId) };
  const input = {
    jsonrpc: "2.0",
    id: 1,
    method,
    commandId: "approve",
    params: method === "interaction.answer" ? item : { items: [item] },
  };
  const first = await rpc.call(input);
  expect(await rpc.call(input)).toEqual(first);
  expect(prepare).not.toHaveBeenCalled();
  expect((await f.records.request(f.source, f.request, f.mac)).state).toBe("running");
  expect(
    (f.database.prepare("SELECT count(*) AS n FROM cell_answer_deliveries").get() as { n: number })
      .n,
  ).toBe(0);
});
it("keeps Cell-owned approval pending across native clearing and interrupted turn completion", async () => {
  const f = fixture(),
    pending = await f.records.request(f.source, f.request, f.mac);
  if (pending.state !== "pending") throw new Error("fixture_pending_missing");
  const interaction = parse(
    InteractionSchema,
    f.store.record("interaction", pending.interactionId),
  );
  runnerEvent(f.store, f.source.claims, "worker", {
    taskId: "task",
    leaseId: new CellLeases(f.store).get("task")?.leaseId,
    sessionId: "session",
    runnerSeq: 1,
    event: { t: "interaction.cleared", nativeRef: interaction.nativeRef, reason: "process_died" },
  });
  expect(f.store.record("interaction", pending.interactionId)?.state).toBe("pending");
  runnerEvent(f.store, f.source.claims, "worker", {
    taskId: "task",
    leaseId: new CellLeases(f.store).get("task")?.leaseId,
    sessionId: "session",
    runnerSeq: 2,
    event: { t: "turn.done", turnId: "turn", status: "interrupted" },
  });
  expect(f.store.record("interaction", pending.interactionId)?.state).toBe("pending");
});
