// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "./daemon-client";
import { memoryService } from "./memory-service";
import { toMemoryView } from "./memory-view";

const entities = {
  agent: [{ id: "writer-agent", name: "Researcher" }],
  project: [{ id: "p1", name: "Website" }],
  subproject: [{ id: "s1", projectId: "p1" }],
  knowledge: [
    {
      id: "k1",
      title: "Launch date",
      body: "March 3",
      kind: "decision",
      scope: { type: "project", id: "p1" },
      writer: { kind: "agent", id: "writer-agent" },
      verification: "unverified",
      status: "active",
      revision: 2,
      updatedAt: "2026-01-02T00:00:00Z",
    },
    {
      id: "k2",
      title: "Tone",
      body: "Plain",
      kind: "preference",
      scope: { type: "user", id: "local-owner" },
      writer: { kind: "human", id: "local-owner" },
      verification: "human",
      status: "active",
      revision: 1,
      updatedAt: "2026-01-03T00:00:00Z",
    },
    { id: "k3", title: "Old", status: "archived", scope: { type: "user", id: "u" } },
  ],
  knowledgeProposal: [
    {
      id: "pr1",
      state: "pending",
      op: "create",
      title: "Uses pnpm",
      body: "The repo uses pnpm.",
      kind: "lesson",
      scope: { type: "subproject", id: "s1" },
      writer: { kind: "agent", id: "writer-agent" },
      reason: "Saw the lockfile",
      createdAt: "2026-01-04T00:00:00Z",
    },
    { id: "pr2", state: "accepted", title: "Done", scope: { type: "user", id: "u" } },
  ],
};

describe("memory view", () => {
  it("lists active entries newest first with who wrote them and where they apply", () => {
    const view = toMemoryView({ entities });
    expect(view.entries.map((entry) => entry.id)).toEqual(["k2", "k1"]);
    expect(view.entries[1]).toMatchObject({
      projectId: "p1",
      projectName: "Website",
      writer: { kind: "agent", name: "Researcher" },
      agent: { id: "writer-agent", name: "Researcher" },
      revision: 2,
    });
    expect(view.entries[0]).toMatchObject({
      projectId: null,
      writer: { kind: "human", name: "" },
      agent: null,
    });
  });

  it("lists pending proposals, placing a narrower scope in its project", () => {
    const view = toMemoryView({ entities });
    expect(view.proposals).toHaveLength(1);
    expect(view.proposals[0]).toMatchObject({
      id: "pr1",
      projectId: "p1",
      projectName: "Website",
      reason: "Saw the lockfile",
    });
  });
});

describe("memory service", () => {
  it("refuses to save over a newer revision", async () => {
    const call = vi.fn(async () => ({ id: "k1", revision: 3, title: "x", body: "y" }));
    const service = memoryService({ call, snapshot: { entities } } as unknown as DaemonClient);
    await expect(service.save({ id: "k1", title: "New", body: "z", revision: 2 })).rejects.toThrow(
      "changed while you were editing",
    );
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("saves new text on top of the current entry", async () => {
    const current = { id: "k1", revision: 2, title: "Old", body: "old", tags: [] };
    const call = vi.fn(async (method: string) => (method === "knowledge.get" ? current : {}));
    const service = memoryService({ call, snapshot: { entities } } as unknown as DaemonClient);
    await service.save({ id: "k1", title: "New", body: "new", revision: 2 });
    expect(call).toHaveBeenLastCalledWith(
      "knowledge.upsert",
      { value: { ...current, title: "New", body: "new" }, expectedRevision: 2 },
      expect.any(String),
    );
  });
});
