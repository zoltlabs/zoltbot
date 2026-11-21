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
      merges: null,
    });
    expect(view.tidy).toBe(true);
  });

  it("shows both texts of a nightly merge and reads the tidy-up setting", () => {
    const view = toMemoryView({
      entities: {
        ...entities,
        knowledge: [
          { id: "a", body: "First text", status: "active" },
          { id: "b", body: "Second text", status: "active" },
        ],
        knowledgeProposal: [
          { id: "m", state: "pending", itemId: "a", merges: { id: "b", revision: 1 } },
        ],
        settings: [{ key: "memory.tidy", value: false }],
      },
    });
    expect(view.proposals[0]?.merges).toEqual({ keep: "First text", drop: "Second text" });
    expect(view.tidy).toBe(false);
  });
});

describe("memory service", () => {
  it("lists skill proposals with the agent's name, and still lists memory when that fails", async () => {
    const call = vi.fn(async () => ({
      proposals: [
        {
          id: "sp1",
          name: "release-checklist",
          content: "---\nname: release-checklist\n---\nTag it.\n",
          base: null,
          agentId: "agent-1",
          createdAt: "2026-01-04T00:00:00Z",
        },
      ],
    }));
    const service = memoryService({ call, snapshot: { entities } } as unknown as DaemonClient);
    const view = await service.list();
    expect(call).toHaveBeenCalledWith("skill.proposal.list", {});
    expect(view.skills).toEqual([
      expect.objectContaining({
        id: "sp1",
        title: "release-checklist",
        base: null,
        projectId: null,
        writer: { kind: "agent", id: "agent-1", name: expect.any(String) },
      }),
    ]);
    call.mockRejectedValueOnce(new Error("offline"));
    expect((await service.list()).skills).toEqual([]);
  });

  it("turns a skill decision error into its sentence", async () => {
    const call = vi.fn(async () => {
      throw new Error(
        "skill_changed: This skill changed after the agent proposed this. Discard it and ask the agent to propose again.",
      );
    });
    const service = memoryService({ call, snapshot: { entities } } as unknown as DaemonClient);
    await expect(service.decideSkill({ id: "sp1", decision: "save" })).rejects.toThrow(
      /^This skill changed after the agent proposed this/,
    );
    expect(call).toHaveBeenCalledWith(
      "skill.proposal.decide",
      { id: "sp1", decision: "save" },
      expect.any(String),
    );
  });

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

  it("previews the picked export and turns daemon errors into a sentence", async () => {
    const call = vi.fn(async () => ({ memories: 3, conversations: 12 }));
    const client = { call, snapshot: { entities } } as unknown as DaemonClient;
    const picked = memoryService(client, async () => "/Users/you/Downloads/chatgpt.zip");
    expect(await picked.importChoose("chatgpt")).toEqual({
      source: "chatgpt",
      path: "/Users/you/Downloads/chatgpt.zip",
      name: "chatgpt.zip",
      memories: 3,
      conversations: 12,
    });
    expect(await memoryService(client, async () => undefined).importChoose("chatgpt")).toBeNull();
    call.mockRejectedValueOnce(new Error("import_file_type: pick the .zip or .json export."));
    await expect(picked.importChoose("chatgpt")).rejects.toThrow("Pick the .zip or .json export.");
  });
});
