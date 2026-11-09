import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import type { AgentDefinition, DomainEvent } from "@zoltbot/protocol";
import { openStore } from "@zoltbot/store";
import { expect, it } from "vitest";
import { creationApi } from "./creation-api.js";
import { entityEditsApi } from "./entity-edits.js";
import { PrivateInputGuard } from "./private-input.js";

const definition: AgentDefinition = {
  id: "sample",
  displayName: "Sample",
  adapter: "acp",
  binaryNames: [],
  versionCommand: [],
  launch: { command: "fake", args: [], env: {} },
  testedVersions: "1.0.0",
  defaults: { permissionProfile: "full_access" },
  staticCapabilities: {},
  nativeSessionRoots: [],
  experimental: false,
};
const profile = {
  id: "profile",
  definitionId: "sample",
  name: "Sample",
  avatar: "S",
  kind: "profile",
  permissionProfile: "workspace_write",
  instructions: "",
  hidden: false,
  archived: false,
};

it("edits a profile's name and model and archives a project, once", async () => {
  mkdirSync(".cache/tests", { recursive: true });
  const root = mkdtempSync(path.resolve(".cache/tests/entity-edits-"));
  const store = await openStore(path.join(root, "store.db"));
  try {
    const events: DomainEvent[] = [];
    const publish = (rows: DomainEvent[]) => events.push(...rows);
    const privacy = new PrivateInputGuard({ store, publish });
    const create = creationApi({
      store,
      privacy,
      publish,
      definitions: async () => ({ definitions: [definition] }),
    });
    const edits = entityEditsApi({ store, privacy, publish });
    const project = {
      id: "project",
      name: "Site",
      goal: "",
      instructions: "",
      constraints: "",
      roots: [],
      hierarchyDepth: 0,
      tags: [],
      requireCodeReview: false,
      skipFinalGateWhenReviewed: false,
      archived: false,
      createdAt: "2026-11-08T12:00:00Z",
    };
    await create("agent.create", { value: profile }, "create-profile");
    await create("project.create", { value: project }, "create-project");

    expect(
      await edits("agent.update", { id: "profile", changes: { name: "Renamed" } }, "rename"),
    ).toMatchObject({ id: "profile", name: "Renamed" });
    await expect(
      edits("agent.update", { id: "profile", changes: { permissionProfile: "full_access" } }, "up"),
    ).rejects.toThrow("field_not_editable");
    await expect(edits("agent.update", { id: "profile", changes: {} }, "none")).rejects.toThrow(
      "invalid_params",
    );

    await expect(
      edits("project.archive", { id: "project", confirmed: false }, "archive-0"),
    ).rejects.toThrow("confirmation_required");
    expect(await edits("project.archive", { id: "project", confirmed: true }, "archive-1")).toEqual(
      { ok: true },
    );
    const seq = store.lastSeq();
    expect(await edits("project.archive", { id: "project", confirmed: true }, "archive-2")).toEqual(
      { ok: true },
    );
    expect(store.lastSeq()).toBe(seq);
    expect(store.record("project", "project")).toMatchObject({ archived: true });
    expect(await edits("project.update", { id: "project" }, "other")).toBeUndefined();
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
