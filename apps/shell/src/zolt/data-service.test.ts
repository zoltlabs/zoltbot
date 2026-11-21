import { describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../shared/ipc";
import type { DaemonClient } from "./daemon-client";
import { csvFileName, dataHandlers } from "./data-service";

function client(call = vi.fn()) {
  return {
    call,
    snapshot: {
      entities: {
        project: [
          { id: "p2", name: "Website" },
          { id: "p1", name: "Sales" },
          { id: "old", name: "Old", archived: true },
        ],
      },
    },
  } as unknown as DaemonClient;
}

describe("Data page handlers", () => {
  it("lists live projects by name and reads tables, rows and CSV from the daemon", async () => {
    const call = vi.fn().mockResolvedValue({ csv: "a\r\n", truncated: false });
    const handlers = dataHandlers(client(call));
    expect(await handlers[IPC_CHANNELS.dataProjects]?.(undefined)).toEqual([
      { id: "p1", name: "Sales" },
      { id: "p2", name: "Website" },
    ]);
    await handlers[IPC_CHANNELS.dataTables]?.("p1");
    expect(call).toHaveBeenLastCalledWith("projectData.tables", { projectId: "p1" });
    await handlers[IPC_CHANNELS.dataRows]?.({ projectId: "p1", table: "leads", offset: 100 });
    expect(call).toHaveBeenLastCalledWith("projectData.rows", {
      projectId: "p1",
      table: "leads",
      offset: 100,
      limit: 100,
    });
    expect(await handlers[IPC_CHANNELS.dataCsv]?.({ projectId: "p1", table: "a/b" })).toEqual({
      name: "a-b.csv",
      csv: "a\r\n",
      truncated: false,
    });
  });

  it("rejects malformed requests before calling the daemon", () => {
    const call = vi.fn();
    const handlers = dataHandlers(client(call));
    expect(() => handlers[IPC_CHANNELS.dataTables]?.(3)).toThrow();
    expect(() =>
      handlers[IPC_CHANNELS.dataRows]?.({ projectId: "p1", table: "t", limit: 501 }),
    ).toThrow("Invalid page.");
    expect(() => handlers[IPC_CHANNELS.dataCsv]?.({ projectId: "p1" })).toThrow();
    expect(call).not.toHaveBeenCalled();
    expect(csvFileName("  ")).toBe("table.csv");
  });
});
