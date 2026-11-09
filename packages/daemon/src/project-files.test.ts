import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import type { DomainEvent } from "@zoltbot/protocol";
import { openStore } from "@zoltbot/store";
import { afterEach, describe, expect, it } from "vitest";
import { creationApi } from "./creation-api.js";
import { PrivateInputGuard } from "./private-input.js";
import { designFilesFor, detectProjectFiles, projectFilesApi } from "./project-files.js";

const made: string[] = [];
function repo(files: string[]) {
  const root = mkdtempSync(join(tmpdir(), "zolt-project-files-"));
  made.push(root);
  for (const file of files) {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), "x");
  }
  return root;
}
afterEach(() => {
  for (const root of made.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("project files", () => {
  it("finds instruction files at the root and design files below it, guides first", () => {
    const root = repo([
      "AGENTS.md",
      "docs/CLAUDE.md",
      "packages/tokens/tokens.css",
      "DESIGN.md",
      "node_modules/pkg/DESIGN.md",
      ".hidden/design.md",
      "src/README.md",
    ]);
    expect(detectProjectFiles({ roots: [{ path: root, label: "Code" }] })).toEqual({
      instructions: [join(root, "AGENTS.md")],
      design: [
        { path: join(root, "DESIGN.md"), kind: "guide" },
        { path: join(root, "packages/tokens/tokens.css"), kind: "tokens" },
      ],
    });
  });

  it("uses the owner's list once edited, even when it is empty", () => {
    const root = repo(["DESIGN.md"]);
    const roots = [{ path: root, label: "Code" }];
    expect(designFilesFor({ roots })).toEqual([join(root, "DESIGN.md")]);
    expect(designFilesFor({ roots, designFiles: [] })).toEqual([]);
    expect(designFilesFor({ roots, designFiles: null })).toEqual([join(root, "DESIGN.md")]);
  });

  it("returns nothing for a workspace without a readable code folder", () => {
    expect(detectProjectFiles({ roots: [] })).toEqual({ instructions: [], design: [] });
    expect(detectProjectFiles({ roots: [{ path: "/no/such/folder", label: "Code" }] })).toEqual({
      instructions: [],
      design: [],
    });
  });
});

describe("project updates", () => {
  it("saves the design list and clears old instructions, and refuses other fields", async () => {
    mkdirSync(".cache/tests", { recursive: true });
    const root = mkdtempSync(path.resolve(".cache/tests/project-files-"));
    made.push(root);
    const store = await openStore(path.join(root, "store.db"));
    try {
      const events: DomainEvent[] = [],
        publish = (rows: DomainEvent[]) => events.push(...rows),
        privacy = new PrivateInputGuard({ store, publish });
      await creationApi({ store, privacy, publish })(
        "project.create",
        {
          value: {
            id: "p1",
            name: "Sample",
            goal: "Old goal",
            instructions: "Old rules",
            constraints: "",
            roots: [],
            hierarchyDepth: 3,
            tags: [],
            requireCodeReview: false,
            skipFinalGateWhenReviewed: false,
            archived: false,
            createdAt: "2026-11-07T12:00:00Z",
          },
        },
        "create",
      );
      const api = projectFilesApi({ store, privacy, publish });
      await api("project.update", { id: "p1", changes: { designFiles: ["/r/DESIGN.md"] } }, "a");
      expect(store.record("project", "p1")?.designFiles).toEqual(["/r/DESIGN.md"]);
      await api("project.update", { id: "p1", changes: { designFiles: null } }, "b");
      expect(store.record("project", "p1")?.designFiles ?? null).toBeNull();
      await api("project.update", { id: "p1", changes: { defaultAgentId: "agent-2" } }, "e");
      expect(store.record("project", "p1")?.defaultAgentId).toBe("agent-2");
      await api("project.update", { id: "p1", changes: { goal: "", instructions: "" } }, "c");
      expect(store.record("project", "p1")).toMatchObject({ goal: "", instructions: "" });
      await expect(
        api("project.update", { id: "p1", changes: { roots: [] } }, "d"),
      ).rejects.toThrow("field_not_editable");
      await expect(api("project.update", { id: "p1", changes: { goal: "x" } })).rejects.toThrow(
        "command_id_required",
      );
      expect(await api("thread.update", { id: "p1", changes: {} }, "e")).toBeUndefined();
    } finally {
      store.close();
    }
  });
});
