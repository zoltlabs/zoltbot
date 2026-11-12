import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { InteractionSchema, parse } from "@zoltbot/protocol";
import { Store } from "@zoltbot/store/portable";
import { afterEach, expect, it, vi } from "vitest";
import { CellSqlDriver } from "../src/sql-driver.js";
import worker from "../src/worker.js";
import { caps } from "./capabilities.js";
import { signer } from "./identity.js";

afterEach(() => vi.restoreAllMocks());
interface Packet {
  id: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message: string };
}
it("routes durable signed requests only to the selected Mac and reconciles results after eviction", async () => {
  const identity = await signer(),
    org = crypto.randomUUID();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (String(url) === env.CELL_JWKS_URL) return Response.json({ keys: [identity.jwk] });
    if (String(url).endsWith("/access"))
      return Response.json({ active: true, canRunTasks: false, canMacExec: true });
    if (!String(url).endsWith("/sandboxes")) throw new Error("unexpected_network");
    const body = JSON.parse(String(init?.body)),
      at = new Date().toISOString();
    return Response.json({
      orgId: body.orgId,
      userId: body.userId,
      taskId: body.taskId,
      sandboxId: "sandbox",
      target: "e2b",
      state: "running",
      sleepKeepsProcesses: false,
      createdAt: at,
      updatedAt: at,
    });
  });
  const rpc = async (method: string, params: unknown, device = "phone") => {
    const response = await worker.fetch(
      new Request(`https://cell.example.invalid/v1/orgs/${org}/rpc`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${await identity.token(org, { device, surface: "phone" })}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          commandId: crypto.randomUUID(),
          method,
          params,
        }),
      }),
      env,
    );
    const packet = (await response.json()) as Packet;
    expect(packet.error).toBeUndefined();
    return packet.result;
  };
  const project = await rpc("cloud.project.create", {
    name: "Repo",
    repository: "example/repository",
    defaultBranch: "main",
    setupScript: "",
  });
  const task = await rpc("task.create", {
    title: "Task",
    brief: "Inspect",
    profileId: "cloud-claude",
    node: { type: "project", id: project?.id },
    location: "sandbox",
  });
  const connect = async (device: string, sandbox = false) => {
    const token = await identity.token(org, {
      device,
      kind: sandbox ? "sandbox_runner" : "mac_runner",
      surface: "runner",
      ...(sandbox ? { task: task?.id, session: undefined } : { grant: "grant" }),
    });
    const response = await worker.fetch(
      new Request(`https://cell.example.invalid/v1/orgs/${org}/connect`, {
        headers: { Authorization: `Bearer ${token}`, Upgrade: "websocket" },
      }),
      env,
    );
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    if (!socket) throw new Error("fixture_socket_missing");
    socket.accept();
    const packets: Packet[] = [];
    socket.addEventListener("message", (event) => {
      const packet = JSON.parse(String(event.data)) as Packet;
      packets.push(packet);
      if (packet.method === "mac.status.request")
        socket.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: packet.id,
            result: {
              available: true,
              targetDeviceId: device,
              mac: "Test Mac",
              osVersion: "15.0",
              cwd: "/home/user/work",
            },
          }),
        );
    });
    const call = async (method: string, params: unknown) => {
      const id = crypto.randomUUID();
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      await vi.waitFor(() => expect(packets.some((packet) => packet.id === id)).toBe(true));
      const result = packets.find((packet) => packet.id === id);
      if (!result) throw new Error("fixture_response_missing");
      return result;
    };
    expect(
      (
        await call("runner.hello", {
          kind: sandbox ? "sandbox" : "mac",
          runnerId: device,
          protocolVersion: 1,
          versions: {},
          clis: [{ id: "claude", version: "fixture" }],
          sleepKeepsProcesses: false,
        })
      ).error,
    ).toBeUndefined();
    return { socket, packets, call };
  };
  const mac = await connect("mac"),
    other = await connect("other"),
    sandbox = await connect("sandbox", true);
  let replacement: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    const lease = sandbox.packets.find((packet) => packet.method === "runner.lease")?.params;
    if (!lease) throw new Error("fixture_lease_missing");
    for (const [index, event] of [
      { t: "session.ready", nativeId: "native", capabilities: caps, providerVersion: "fixture" },
      { t: "turn.started", turnId: "turn" },
    ].entries())
      expect(
        (
          await sandbox.call("runner.event", {
            taskId: task?.id,
            leaseId: lease.leaseId,
            sessionId: "session",
            runnerSeq: index + 1,
            event,
          })
        ).error,
      ).toBeUndefined();
    expect(
      (
        await sandbox.call("runner.heartbeat", {
          runnerId: "sandbox",
          leaseIds: [lease.leaseId],
          at: new Date().toISOString(),
        })
      ).error,
    ).toBeUndefined();
    const base = {
      requestId: "request",
      taskId: String(task?.id),
      turnId: "turn",
      userId: "member",
      targetDeviceId: "mac",
    };
    expect((await sandbox.call("mac.status.request", base)).result?.available).toBe(true);
    expect(
      (await sandbox.call("mac.status.request", { ...base, userId: "other" })).error?.message,
    ).toBe("forbidden");
    const { targetDeviceId: _selected, ...choose } = base;
    expect((await sandbox.call("mac.status.request", choose)).result?.reason).toBe("choose_mac");
    const request = { ...base, command: "uname", cwd: "/home/user/work" };
    const pending = await sandbox.call("mac.exec.request", request);
    expect(pending.result?.state).toBe("pending");
    expect((await sandbox.call("mac.exec.request", request)).result).toEqual(pending.result);
    expect(
      (await sandbox.call("mac.exec.request", { ...request, command: "false" })).error?.message,
    ).toBe("command_conflict");
    expect(mac.packets.filter((packet) => packet.method === "mac.exec.request")).toHaveLength(0);
    const stub = env.ORG_CELLS.get(env.ORG_CELLS.idFromName(org));
    const interaction = await runInDurableObject(stub, (_instance, state) =>
      parse(
        InteractionSchema,
        new Store(new CellSqlDriver(state.storage)).record(
          "interaction",
          String(pending.result?.interactionId),
        ),
      ),
    );
    const draft = interaction.context?.macExec;
    if (!draft) throw new Error("fixture_draft_missing");
    const now = Date.now();
    await rpc("interaction.answer", {
      id: interaction.id,
      version: interaction.version,
      answer: {
        action: "accept",
        choice: "allow_once",
        by: { kind: "human", id: "member" },
        at: new Date(now).toISOString(),
        signedApproval: {
          payload: { ...draft, signerDeviceId: "phone", issuedAt: now, expiresAt: now + 300000 },
          signature: "A".repeat(86),
        },
      },
    });
    await vi.waitFor(() =>
      expect(mac.packets.filter((packet) => packet.method === "mac.exec.request")).toHaveLength(1),
    );
    expect(other.packets.filter((packet) => packet.method === "mac.exec.request")).toHaveLength(0);
    const command = mac.packets.find((packet) => packet.method === "mac.exec.request");
    if (!command) throw new Error("fixture_command_missing");
    expect(command.params?.approval).toBeDefined();
    await evictDurableObject(stub);
    replacement = await connect("mac");
    await vi.waitFor(() =>
      expect(
        replacement?.packets.some(
          (packet) => packet.id === command.id && packet.method === "mac.exec.request",
        ),
      ).toBe(true),
    );
    const result = {
      requestId: "request",
      taskId: task?.id,
      exitCode: 0,
      stdout: "synthetic-output",
      stderr: "",
      durationMs: 1,
      truncated: false,
      mac: "Test Mac",
    };
    other.socket.send(JSON.stringify({ jsonrpc: "2.0", id: command.id, result }));
    await vi.waitFor(() =>
      expect(other.packets.find((packet) => packet.id === command.id)?.error?.message).toBe(
        "forbidden",
      ),
    );
    replacement.socket.send(JSON.stringify({ jsonrpc: "2.0", id: command.id, result }));
    await vi.waitFor(async () =>
      expect((await sandbox.call("mac.exec.request", request)).result?.state).toBe("complete"),
    );
    replacement.socket.send(JSON.stringify({ jsonrpc: "2.0", id: command.id, result }));
    expect((await sandbox.call("mac.exec.request", request)).result?.result).toEqual(result);
  } finally {
    mac.socket.close();
    replacement?.socket.close();
    other.socket.close();
    sandbox.socket.close();
  }
});
