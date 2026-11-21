// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { CO_AUTHOR_CHANNELS } from "../shared/co-author";
import { coAuthorHandlers, projectCoAuthor } from "./co-author-service";

const rows: Record<string, Record<string, unknown>[]> = {
  thread: [
    { id: "chat", projectId: "web" },
    { id: "loose", projectId: "notes" },
  ],
  project: [
    { id: "web", roots: [{ path: "/w", label: "Web", repoRoot: "/w" }] },
    { id: "notes", roots: [{ path: "/n", label: "Notes" }] },
  ],
};

describe("co-author line setting", () => {
  it("is on unless the project turned it off, and only for projects with a repository", () => {
    const client = { rows: (kind: string) => rows[kind] ?? [], call: vi.fn() };
    expect(projectCoAuthor(client, "chat")).toEqual({ projectId: "web", enabled: true });
    expect(projectCoAuthor(client, "loose")).toBeNull();
    const off = {
      ...client,
      rows: (kind: string) =>
        kind === "project" ? [{ ...rows.project?.[0], coAuthorLine: false }] : (rows[kind] ?? []),
    };
    expect(projectCoAuthor(off, "chat")).toEqual({ projectId: "web", enabled: false });
  });

  it("saves the switch on the project", async () => {
    const call = vi.fn().mockResolvedValue({});
    const handlers = coAuthorHandlers({ rows: () => [], call });
    await handlers[CO_AUTHOR_CHANNELS.coAuthorSet]?.({ projectId: "web", enabled: false });
    expect(call).toHaveBeenCalledWith(
      "project.update",
      { id: "web", changes: { coAuthorLine: false } },
      expect.any(String),
    );
    await expect(
      Promise.resolve().then(() =>
        handlers[CO_AUTHOR_CHANNELS.coAuthorSet]?.({ projectId: "web" }),
      ),
    ).rejects.toThrow();
  });
});
