import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import type { AgentDefinition, DomainEvent } from "@zoltbot/protocol";
import { openStore } from "@zoltbot/store";
import { expect, it } from "vitest";
import { creationApi } from "./creation-api.js";
import { PrivateInputGuard } from "./private-input.js";

const at = "2026-10-28T12:00:00Z";
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
const thread = {
  id: "thread",
  agentId: "profile",
  title: "New conversation",
  titleSource: "auto",
  kind: "main",
  pinned: false,
  archived: false,
  createdAt: at,
  lastActivityAt: at,
};
async function fixture(current = definition) {
  mkdirSync(".cache/tests", { recursive: true });
  const root = mkdtempSync(path.resolve(".cache/tests/creation-api-"));
  const store = await openStore(path.join(root, "store.db"));
  const events: DomainEvent[] = [],
    privacy = new PrivateInputGuard({ store, publish: (rows) => events.push(...rows) });
  const api = creationApi({
    store,
    privacy,
    publish: (rows) => events.push(...rows),
    definitions: async () => ({ definitions: [current] }),
  });
  return {
    store,
    api,
    privacy,
    events,
    close() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
it("creates a profile with its definition and a thread through durable replayable commands", async () => {
  const test = await fixture();
  try {
    expect(await test.api("agent.create", { value: profile }, "profile-command")).toEqual(profile);
    expect(test.store.snapshot().agentDefinition).toEqual([definition]);
    expect(await test.api("thread.create", { value: thread }, "thread-command")).toEqual(thread);
    const before = test.store.lastSeq();
    expect(await test.api("agent.create", { value: { ...profile } }, "profile-command")).toEqual(
      profile,
    );
    expect(await test.api("thread.create", { value: thread }, "thread-command")).toEqual(thread);
    expect(test.store.lastSeq()).toBe(before);
    await expect(
      test.api("agent.create", { value: { ...profile, name: "Changed" } }, "profile-command"),
    ).rejects.toThrow("command_receipt_conflict");
    const snapshot = test.store.snapshot();
    test.store.rebuild();
    expect(test.store.snapshot()).toEqual(snapshot);
    expect(test.events).toHaveLength(before);
  } finally {
    test.close();
  }
});
it("rejects unknown definitions, private drafts, and unconfirmed full access without partial writes", async () => {
  const test = await fixture();
  try {
    test.privacy.remember("synthetic-private-profile-value");
    await expect(
      test.api("agent.create", { value: { ...profile, definitionId: "absent" } }, "absent"),
    ).rejects.toThrow("agent_definition_unavailable");
    await expect(
      test.api(
        "agent.create",
        { value: { ...profile, instructions: "synthetic-private-profile-value" } },
        "private",
      ),
    ).rejects.toThrow("private_value_requires_secure_field");
    await expect(
      test.api("agent.create", { value: { ...profile, permissionProfile: "full_access" } }, "full"),
    ).rejects.toThrow("confirmation_required");
    expect(test.store.lastSeq()).toBe(0);
    expect(test.store.receipt("full")).toBeUndefined();
  } finally {
    test.close();
  }
});
it("does not copy credential literals from a definition into durable configuration", async () => {
  const test = await fixture({
    ...definition,
    launch: { ...definition.launch, env: { SERVICE_API_KEY: "synthetic-private-definition-key" } },
  });
  try {
    await expect(test.api("agent.create", { value: profile }, "unsafe-config")).rejects.toThrow(
      "definition_private_configuration_required",
    );
    expect(test.store.lastSeq()).toBe(0);
  } finally {
    test.close();
  }
});

it("fences concurrent reuse of one creation command against a different profile draft", async () => {
  const test = await fixture();
  try {
    const results = await Promise.allSettled([
      test.api("agent.create", { value: profile }, "race"),
      test.api("agent.create", { value: { ...profile, name: "Other" } }, "race"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: new Error("command_receipt_conflict"),
    });
    expect(test.store.snapshot().agent).toHaveLength(1);
    expect(test.store.snapshot().agentDefinition).toHaveLength(1);
  } finally {
    test.close();
  }
});

it("rejects disabled experimental definitions and threads without an active profile", async () => {
  const test = await fixture({ ...definition, experimental: true });
  try {
    await expect(test.api("agent.create", { value: profile }, "experimental")).rejects.toThrow(
      "experimental_provider_disabled",
    );
    await expect(test.api("thread.create", { value: thread }, "orphan")).rejects.toThrow(
      "profile_unavailable",
    );
    expect(test.store.lastSeq()).toBe(0);
  } finally {
    test.close();
  }
});

it("checks every definition value before copying configuration into the store", async () => {
  const secret = "synthetic-private-definition-metadata";
  const test = await fixture({ ...definition, staticCapabilities: { unsafeMetadata: secret } });
  test.privacy.remember(secret);
  try {
    await expect(
      test.api("agent.create", { value: profile }, "private-definition"),
    ).rejects.toThrow("private_value_requires_secure_field");
    expect(test.store.lastSeq()).toBe(0);
    expect(test.store.receipt("private-definition")).toBeUndefined();
  } finally {
    test.close();
  }
});

it("keeps a public token budget setting distinct from a credential variable", async () => {
  const test = await fixture({
    ...definition,
    launch: { ...definition.launch, env: { MAX_TOKENS: "4096" } },
  });
  try {
    expect(await test.api("agent.create", { value: profile }, "public-budget")).toEqual(profile);
  } finally {
    test.close();
  }
});

it("requires an available project for new threads and preserves committed replay after archival", async () => {
  const test = await fixture();
  const project = {
    id: "project",
    name: "Synthetic project",
    goal: "",
    instructions: "",
    constraints: "",
    roots: [],
    hierarchyDepth: 0,
    tags: [],
    requireCodeReview: true,
    skipFinalGateWhenReviewed: false,
    archived: false,
    createdAt: at,
  };
  const writeProject = (archived: boolean) =>
    test.store.dispatch(`project:${archived}`, () => ({
      events: [
        {
          eventId: `project:${archived}`,
          aggregateType: "project",
          aggregateId: project.id,
          type: archived ? "project.updated" : "project.created",
          occurredAt: at,
          payload: { ...project, archived },
        },
      ],
      result: {},
    }));
  try {
    await test.api("agent.create", { value: profile }, "profile");
    await expect(
      test.api("thread.create", { value: { ...thread, projectId: "missing" } }, "missing-project"),
    ).rejects.toThrow("project_unavailable");
    writeProject(false);
    const value = { ...thread, projectId: project.id };
    expect(await test.api("thread.create", { value }, "scoped-thread")).toEqual(value);
    writeProject(true);
    expect(await test.api("thread.create", { value }, "scoped-thread")).toEqual(value);
    await expect(
      test.api("thread.create", { value: { ...value, id: "another-thread" } }, "archived-project"),
    ).rejects.toThrow("project_unavailable");
    expect(test.store.receipt("missing-project")).toBeUndefined();
    expect(test.store.receipt("archived-project")).toBeUndefined();
    expect(test.store.snapshot().thread).toEqual([value]);
  } finally {
    test.close();
  }
});
it("checks project availability inside the thread transaction after asynchronous input validation", async () => {
  const test = await fixture();
  const project = {
    id: "project",
    name: "Synthetic project",
    goal: "",
    instructions: "",
    constraints: "",
    roots: [],
    hierarchyDepth: 0,
    tags: [],
    requireCodeReview: true,
    skipFinalGateWhenReviewed: false,
    archived: false,
    createdAt: at,
  };
  try {
    await test.api("agent.create", { value: profile }, "profile");
    test.store.dispatch("project", () => ({
      events: [
        {
          eventId: "project",
          aggregateType: "project",
          aggregateId: project.id,
          type: "project.created",
          occurredAt: at,
          payload: project,
        },
      ],
      result: {},
    }));
    const pending = test.api(
      "thread.create",
      { value: { ...thread, projectId: project.id } },
      "racing-thread",
    );
    test.store.dispatch("archive-project", () => ({
      events: [
        {
          eventId: "archive-project",
          aggregateType: "project",
          aggregateId: project.id,
          type: "project.updated",
          occurredAt: at,
          payload: { ...project, archived: true },
        },
      ],
      result: {},
    }));
    await expect(pending).rejects.toThrow("project_unavailable");
    expect(test.store.snapshot().thread ?? []).toHaveLength(0);
    expect(test.store.receipt("racing-thread")).toBeUndefined();
  } finally {
    test.close();
  }
});
