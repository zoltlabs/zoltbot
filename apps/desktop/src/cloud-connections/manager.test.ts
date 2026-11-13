import { expect, it, vi } from "vitest";
import type { ConnectionState } from "../../../../packages/ui/src/connection.js";
import { connectionManager, type NativeConnection, type OwnedConnectionState } from "./manager.js";

function connection(name: string) {
  let listener: ((state: ConnectionState) => void) | undefined;
  const stopped = vi.fn(),
    start = vi.fn(async () => {}),
    call = vi.fn(
      async (_method: string, _params: unknown, _commandId?: string): Promise<unknown> => ({
        name,
      }),
    );
  const port: NativeConnection = {
    start,
    stop: stopped,
    call,
    subscribe(next) {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
  };
  const state = (status: ConnectionState["status"], error?: string): ConnectionState => ({
    status,
    snapshot: { seq: 3, entities: { project: [{ id: "same-id", name }] }, counters: {} },
    ...(error ? { error } : {}),
  });
  return {
    port,
    stopped,
    start,
    call,
    state,
    emit: (next: ConnectionState) => listener?.(next),
    late: () => listener,
  };
}
const first = {
    userId: "first",
    sessionId: "first-session",
    orgId: "personal",
    name: "First organization",
  },
  second = {
    userId: "second",
    sessionId: "second-session",
    orgId: "other",
    name: "Second organization",
  };

it("routes colliding Local/cloud project IDs by owner and keeps Local running through Cloud loss", async () => {
  const mac = connection("Mac project"),
    cell = connection("Cloud project"),
    factory = vi.fn(() => cell.port),
    manager = connectionManager({ local: () => mac.port, cloud: factory });
  try {
    mac.emit(mac.state("online"));
    await expect(manager.call({ kind: "local" }, "project.list", {})).resolves.toEqual({
      name: "Mac project",
    });
    expect(factory).not.toHaveBeenCalled();
    manager.setAccount(first);
    cell.emit(cell.state("online"));
    const owner = { kind: "cloud" as const, orgId: first.orgId, sessionId: first.sessionId };
    await expect(manager.call(owner, "project.list", {})).resolves.toEqual({
      name: "Cloud project",
    });
    expect(manager.states().map((state) => state.name)).toEqual(["This Mac", "First organization"]);
    cell.emit(cell.state("offline"));
    expect(manager.states()[1]).toMatchObject({
      readOnly: true,
      state: { snapshot: { entities: { project: [{ name: "Cloud project" }] } } },
    });
    await expect(manager.call(owner, "task.create", {}, "queued-task")).rejects.toThrow(
      "cloud_offline",
    );
    expect(cell.call).toHaveBeenCalledTimes(1);
    await expect(manager.call({ kind: "local" }, "project.list", {})).resolves.toEqual({
      name: "Mac project",
    });
    expect(mac.stopped).not.toHaveBeenCalled();
    cell.emit(cell.state("online"));
    expect(cell.call).toHaveBeenCalledTimes(1); // No offline command replay.
    await expect(manager.call(owner, "detect.scan", {})).rejects.toThrow("method_unavailable");
    await expect(manager.call(owner, "constructor", {})).rejects.toThrow("method_unavailable");
    await expect(manager.call({ kind: "local" }, "cloud.project.create", {})).rejects.toThrow(
      "method_unavailable",
    );
  } finally {
    manager.close();
  }
});

it("purges before switching accounts and fences old calls, snapshots and callbacks", async () => {
  const mac = connection("Mac project"),
    one = connection("Private first project"),
    two = connection("Second project"),
    factory = vi.fn().mockReturnValueOnce(one.port).mockReturnValueOnce(two.port),
    manager = connectionManager({ local: () => mac.port, cloud: factory }),
    seen: OwnedConnectionState[][] = [],
    stop = manager.subscribe((states) => seen.push(states));
  try {
    manager.setAccount(first);
    one.emit(one.state("online"));
    const oldNotification = one.late();
    let resolve: ((result: unknown) => void) | undefined;
    one.call.mockImplementationOnce(
      async () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const owner = { kind: "cloud" as const, orgId: first.orgId, sessionId: first.sessionId },
      pending = manager.call(owner, "project.list", {});
    const refused = expect(pending).rejects.toThrow("account_session_changed");
    manager.setAccount(second);
    expect(seen.some((states) => states.length === 1 && states[0]?.owner.kind === "local")).toBe(
      true,
    );
    expect(one.stopped).toHaveBeenCalledOnce();
    oldNotification?.(one.state("online"));
    resolve?.({ name: "Private first result" });
    await refused;
    expect(JSON.stringify(manager.states())).not.toContain("Private first");
    await expect(manager.call(owner, "task.create", {})).rejects.toThrow("account_session_changed");
    expect(one.call).toHaveBeenCalledTimes(1);
    two.emit(two.state("online"));
    const copy = manager.states();
    copy[1]?.state.snapshot.entities.project?.push({ id: "forged" });
    expect(manager.states()[1]?.state.snapshot.entities.project).toHaveLength(1);
    manager.setAccount(second);
    expect(factory).toHaveBeenCalledTimes(2);
    manager.setAccount();
    expect(two.stopped).toHaveBeenCalledOnce();
    expect(manager.states()).toHaveLength(1);
    expect(mac.stopped).not.toHaveBeenCalled();
  } finally {
    stop();
    manager.close();
  }
});

it("revocation clears the Cloud cache instead of treating it as an ordinary outage", async () => {
  const mac = connection("Mac project"),
    cell = connection("Private project"),
    manager = connectionManager({ local: () => mac.port, cloud: () => cell.port });
  manager.setAccount(first);
  cell.emit(cell.state("online"));
  const stale = cell.late();
  cell.emit(cell.state("offline", "unauthorized"));
  expect(manager.states()).toHaveLength(1);
  expect(cell.stopped).toHaveBeenCalledOnce();
  stale?.(cell.state("online"));
  expect(manager.states()).toHaveLength(1);
  await expect(
    manager.call(
      { kind: "cloud", orgId: first.orgId, sessionId: first.sessionId },
      "project.list",
      {},
    ),
  ).rejects.toThrow("account_session_changed");
  manager.close();
  manager.close();
  expect(mac.stopped).toHaveBeenCalledOnce();
  await expect(manager.call({ kind: "local" }, "project.list", {})).rejects.toThrow(
    "connection_closed",
  );
});

it("does not start an already-revoked Cloud transport returned by a factory", () => {
  const mac = connection("Mac project"),
    cell = connection("Private project"),
    unsubscribe = vi.fn();
  cell.port.subscribe = (listener) => {
    listener(cell.state("offline", "unauthorized"));
    return unsubscribe;
  };
  const manager = connectionManager({ local: () => mac.port, cloud: () => cell.port });
  try {
    manager.setAccount(first);
    expect(manager.states()).toHaveLength(1);
    expect(cell.start).not.toHaveBeenCalled();
    expect(cell.stopped).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
  } finally {
    manager.close();
  }
});
