import { once } from "node:events";
import { handle } from "@zoltbot/core";
import type { TerminalInfo, TerminalOutput } from "@zoltbot/protocol";
import { expect, it, vi } from "vitest";
import WebSocket from "ws";
import { at, runtimeFixture } from "../../../tools/fakes/src/runtime-fixture.js";
import { startDaemon } from "./api.js";

class Client {
  private id = 0;
  private pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  constructor(readonly socket: WebSocket) {
    socket.on("message", (data) => {
      const response = JSON.parse(data.toString());
      const pending = this.pending.get(response.id);
      this.pending.delete(response.id);
      if (response.error) pending?.reject(Error(response.error.message));
      else pending?.resolve(response.result);
    });
  }
  call(method: string, params: unknown, commandId?: string) {
    const id = ++this.id;
    const result = new Promise<unknown>((resolve, reject) =>
      this.pending.set(id, { resolve, reject }),
    );
    this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params, commandId }));
    return result;
  }
}
it("authenticates terminal APIs, rejects client cwd, reconnects without duplicate PTYs and does not broadcast shell output", async () => {
  const fixture = await runtimeFixture("zoltbot.db");
  fixture.store.dispatch("allow", (state) =>
    handle(
      state,
      {
        type: "update",
        kind: "agent",
        id: "profile",
        changes: { permissionProfile: "workspace_write" },
        confirmed: true,
      },
      { commandId: "allow", at, actor: { kind: "human", id: "owner" } },
    ),
  );
  fixture.store.close();
  vi.stubEnv("HOME", fixture.root);
  vi.stubEnv("SHELL", "/bin/sh");
  const daemon = await startDaemon({ dataDir: fixture.root, origins: ["http://127.0.0.1:5198"] });
  const clients: Client[] = [];
  const connect = async () => {
    const socket = new WebSocket(daemon.url);
    await once(socket, "open");
    const client = new Client(socket);
    clients.push(client);
    return client;
  };
  try {
    const bad = await connect();
    await expect(bad.call("terminal.list", { threadId: "thread" })).rejects.toThrow("unauthorized");
    const client = await connect();
    await client.call("hello", { token: daemon.token, protocolVersion: 1 });
    const create = { threadId: "thread", confirmed: true, cols: 80, rows: 20 };
    await expect(
      client.call("terminal.create", { ...create, cwd: "/client-filesystem" }, "invalid"),
    ).rejects.toThrow();
    const terminal = (await client.call("terminal.create", create, "create")) as TerminalInfo;
    const scope = { id: terminal.id, threadId: "thread" };
    const attachment = (await client.call("terminal.attach", scope)) as { attachmentId: string };
    client.socket.close();
    const reconnected = await connect();
    await reconnected.call("hello", { token: daemon.token, protocolVersion: 1 });
    expect(await reconnected.call("terminal.create", create, "create")).toEqual(terminal);
    await expect(
      reconnected.call("terminal.read", { ...scope, ...attachment, offset: 0 }),
    ).rejects.toThrow("terminal_attachment_unavailable");
    const next = (await reconnected.call("terminal.attach", scope)) as { attachmentId: string };
    await reconnected.call(
      "terminal.input",
      { ...scope, data: "printf 'ZOLT_API_SYNTHETIC\\n'\r" },
      "input",
    );
    let offset = 0,
      text = "";
    while (!text.includes("ZOLT_API_SYNTHETIC")) {
      const output = (await reconnected.call("terminal.read", {
        ...scope,
        ...next,
        offset,
      })) as TerminalOutput;
      text += output.data;
      offset = output.offset;
    }
    expect(
      ((await reconnected.call("terminal.list", { threadId: "thread" })) as { items: unknown[] })
        .items,
    ).toHaveLength(1);
    await reconnected.call("terminal.close", scope, "stop");
    expect(daemon.logger.lines.join("\n")).not.toContain("ZOLT_API_SYNTHETIC");
  } finally {
    for (const client of clients) client.socket.terminate();
    await daemon.close();
    fixture.close();
    vi.unstubAllEnvs();
  }
}, 30000);
