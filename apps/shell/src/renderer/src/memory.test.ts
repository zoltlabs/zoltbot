import { describe, expect, it } from "vitest";
import type { MemoryEntry, MemoryView } from "../../shared/memory";
import { agentOptions, EVERYWHERE, filterMemory, projectOptions } from "./memory";

const entry = (id: string, patch: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id,
  title: id,
  body: `${id} body`,
  kind: "lesson",
  projectId: "p1",
  projectName: "Website",
  writer: { kind: "agent", id: "a1", name: "Researcher" },
  agent: { id: "a1", name: "Researcher" },
  verification: "unverified",
  status: "active",
  revision: 1,
  updatedAt: "2026-01-01T00:00:00Z",
  ...patch,
});

const view: MemoryView = {
  entries: [
    entry("units", { body: "Use grams." }),
    entry("tone", {
      projectId: null,
      projectName: "",
      writer: { kind: "human", id: "", name: "" },
      agent: null,
    }),
    entry("deploys", {
      projectId: "p2",
      projectName: "Api",
      // The owner edited it last; it still belongs to the agent.
      writer: { kind: "human", id: "", name: "" },
      agent: { id: "a2", name: "Builder" },
    }),
  ],
  proposals: [],
};

describe("filterMemory", () => {
  const all = { agentId: "", projectId: "", query: "" };
  it("filters by the owning agent, even after the owner edited it, and by project and text", () => {
    const ids = (filter: Partial<typeof all>) =>
      filterMemory(view.entries, { ...all, ...filter }).map((item) => item.id);
    expect(ids({})).toEqual(["units", "tone", "deploys"]);
    expect(ids({ agentId: "a2" })).toEqual(["deploys"]);
    expect(ids({ projectId: "p1" })).toEqual(["units"]);
    expect(ids({ projectId: EVERYWHERE })).toEqual(["tone"]);
    expect(ids({ query: "GRAMS" })).toEqual(["units"]);
  });
});

describe("filter options", () => {
  it("lists agents that wrote something, by name", () => {
    expect(agentOptions(view, "An agent")).toEqual([
      { value: "a2", label: "Builder" },
      { value: "a1", label: "Researcher" },
    ]);
  });

  it("lists projects by name, then Everywhere when something applies everywhere", () => {
    expect(projectOptions(view, "Everywhere", "Unknown project")).toEqual([
      { value: "p2", label: "Api" },
      { value: "p1", label: "Website" },
      { value: EVERYWHERE, label: "Everywhere" },
    ]);
  });
});
