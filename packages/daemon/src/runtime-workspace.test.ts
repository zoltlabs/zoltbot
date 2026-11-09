import { mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { handle } from "@zoltbot/core";
import { AgentDefinitionSchema, ProfileSchema, parse, ThreadSchema } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { at, runtimeFixture } from "../../../tools/fakes/src/runtime-fixture.js";
import { runtimeWorkspace } from "./runtime-workspace.js";

async function fixture() {
  const f = await runtimeFixture();
  const input = () => {
    const state = f.store.snapshot();
    return {
      thread: parse(ThreadSchema, state.thread?.[0]),
      profile: parse(ProfileSchema, state.agent?.[0]),
      definition: parse(AgentDefinitionSchema, state.agentDefinition?.[0]),
    };
  };
  let counter = 0;
  const change = (kind: "thread" | "project", id: string, changes: Record<string, unknown>) => {
    const commandId = `change:${++counter}`;
    f.store.dispatch(commandId, (state) =>
      handle(
        state,
        { type: "update", kind, id, changes },
        { commandId, at, actor: { kind: "human", id: "owner" } },
      ),
    );
  };
  const root = path.join(f.root, "managed");
  mkdirSync(root);
  const resolve = runtimeWorkspace({ store: f.store, directory: root });
  return { ...f, input, resolve, change, managed: root };
}
it("creates a private conversation folder within owned data and keeps resume fixed without recreating a missing workspace", async () => {
  const f = await fixture();
  try {
    const first = await f.resolve(f.input());
    expect(path.relative(f.managed, first.cwd).startsWith("workspaces/")).toBe(true);
    expect(statSync(first.cwd).mode & 0o777).toBe(0o700);
    expect(await f.resolve(f.input())).toEqual(first);
    const previous = { nativeId: "native", cwd: first.cwd, provider: "reference" };
    expect(await f.resolve({ ...f.input(), previous })).toEqual(first);
    await expect(
      f.resolve({ ...f.input(), previous: { ...previous, cwd: f.root } }),
    ).rejects.toThrow("native_cwd_changed");
    rmSync(first.cwd, { recursive: true });
    await expect(f.resolve({ ...f.input(), previous })).rejects.toThrow(
      "runtime_workspace_unavailable",
    );
    expect(() => statSync(first.cwd)).toThrow();
  } finally {
    f.close();
  }
});
it("uses one verified project root without modifying it and requires a choice for multiple distinct roots", async () => {
  const f = await fixture();
  const first = path.join(f.root, "project"),
    second = path.join(f.root, "another");
  mkdirSync(first);
  mkdirSync(second);
  writeFileSync(path.join(first, "untouched"), "source unchanged");
  const project = {
    id: "project",
    name: "Fixture",
    goal: "",
    instructions: "",
    constraints: "",
    roots: [{ path: first, label: "Main" }],
    hierarchyDepth: 0,
    tags: [],
    requireCodeReview: false,
    skipFinalGateWhenReviewed: false,
    archived: false,
    createdAt: at,
  };
  try {
    f.store.dispatch("project", (state) =>
      handle(
        state,
        { type: "create", kind: "project", value: project },
        { commandId: "project", at, actor: { kind: "human", id: "owner" } },
      ),
    );
    f.change("thread", "thread", { projectId: "project" });
    expect(await f.resolve(f.input())).toEqual({ cwd: first });
    expect(readFileSync(path.join(first, "untouched"), "utf8")).toBe("source unchanged");
    f.change("project", "project", { roots: [...project.roots, { path: second, label: "Other" }] });
    await expect(f.resolve(f.input())).rejects.toThrow("runtime_workspace_choice_required");
    expect(
      await f.resolve({
        ...f.input(),
        previous: { cwd: first, nativeId: "native", provider: "reference" },
      }),
    ).toEqual({ cwd: first });
    f.change("project", "project", { roots: [] });
    expect((await f.resolve(f.input())).cwd.startsWith(f.managed)).toBe(true);
  } finally {
    f.close();
  }
});
it("refuses symlink replacement of a managed conversation directory", async () => {
  const f = await fixture();
  try {
    const result = await f.resolve(f.input());
    rmSync(result.cwd, { recursive: true });
    const outside = path.join(f.root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, result.cwd);
    await expect(f.resolve(f.input())).rejects.toThrow("runtime_workspace_unavailable");
  } finally {
    f.close();
  }
});

it("uses only the task's active workspace and never substitutes a managed folder for a missing assignment", async () => {
  const f = await fixture();
  const folder = path.join(f.root, "task-folder");
  mkdirSync(folder);
  let command = 0;
  const create = (kind: "task" | "workspace", value: Record<string, unknown>) => {
    const commandId = `create:${++command}`;
    f.store.dispatch(commandId, (state) =>
      handle(
        state,
        { type: "create", kind, value },
        { commandId, at, actor: { kind: "human", id: "owner" } },
      ),
    );
  };
  try {
    f.change("thread", "thread", { taskId: "task" });
    await expect(f.resolve(f.input())).rejects.toThrow("runtime_workspace_choice_required");
    create("workspace", {
      id: "task-workspace",
      kind: "folder",
      path: folder,
      state: "active",
      createdAt: at,
    });
    create("task", {
      id: "task",
      rootId: "task",
      title: "Fixture",
      brief: "Read the fixture",
      acceptance: "Verified",
      expectedDeliverable: "Report",
      ownerAgentId: "profile",
      threadId: "thread",
      workspaceMode: "shared",
      workspaceId: "task-workspace",
      state: "queued",
      revision: 1,
      attempt: 1,
      maxAttempts: 1,
      reviewRequired: false,
      executionLocation: "local",
      createdBy: { kind: "human", id: "owner" },
      createdAt: at,
      updatedAt: at,
    });
    expect(await f.resolve(f.input())).toEqual({ cwd: folder });
    rmSync(folder, { recursive: true });
    await expect(f.resolve(f.input())).rejects.toThrow("runtime_workspace_unavailable");
    expect(() => statSync(path.join(f.managed, "workspaces"))).toThrow();
  } finally {
    f.close();
  }
});

it("inherits only workspace and ancestor direction instructions and uses a private folder when no code root is selected", async () => {
  const f = await fixture();
  const create = (kind: "project" | "subproject", value: Record<string, unknown>) => {
    f.store.dispatch(`scope:${value.id}`, (state) =>
      handle(
        state,
        { type: "create", kind, value },
        { commandId: `scope:${value.id}`, at, actor: { kind: "human", id: "owner" } },
      ),
    );
  };
  try {
    create("project", {
      id: "zolt",
      name: "Zolt",
      goal: "Health",
      instructions: "Small changes",
      constraints: "Run checks",
      roots: [],
      hierarchyDepth: 3,
      tags: [],
      requireCodeReview: false,
      skipFinalGateWhenReviewed: false,
      archived: false,
      createdAt: at,
    });
    create("subproject", {
      id: "product",
      projectId: "zolt",
      name: "Product",
      label: "Direction",
      goal: "Useful",
      instructions: "Test features",
      depth: 1,
      archived: false,
      createdAt: at,
    });
    create("subproject", {
      id: "food",
      parentId: "product",
      projectId: "zolt",
      name: "Food",
      label: "Direction",
      goal: "Log food",
      instructions: "Handle units",
      depth: 2,
      archived: false,
      createdAt: at,
    });
    create("subproject", {
      id: "reliability",
      parentId: "product",
      projectId: "zolt",
      name: "Reliability",
      label: "Direction",
      goal: "Reliable",
      instructions: "Sibling private context",
      depth: 2,
      archived: false,
      createdAt: at,
    });
    f.change("thread", "thread", { projectId: "zolt", node: { type: "subproject", id: "food" } });
    const resolved = await f.resolve(f.input());
    expect(resolved.cwd.startsWith(f.managed)).toBe(true);
    expect(resolved.instructions).toBe(
      "Workspace: Zolt\nGoal: Health\nInstructions: Small changes\nConstraints: Run checks\n\nTeam: Product\nGoal: Useful\nInstructions: Test features\n\nTeam: Food\nGoal: Log food\nInstructions: Handle units",
    );
    expect(resolved.instructions).not.toContain("Sibling");
    // With a main agent, managers are asked to bring back ideas; other chats are not.
    f.store.dispatch("chief-thread", (state) =>
      handle(
        state,
        {
          type: "create",
          kind: "thread",
          value: {
            id: "chief",
            agentId: "profile",
            kind: "main",
            title: "Zolt",
            titleSource: "human",
            pinned: false,
            archived: false,
            createdAt: at,
            lastActivityAt: at,
          },
        },
        { commandId: "chief-thread", at, actor: { kind: "human", id: "owner" } },
      ),
    );
    f.store.dispatch("chief-pointer", (state) =>
      handle(
        state,
        { type: "create", kind: "settings", value: { key: "chief.thread", value: "chief" } },
        { commandId: "chief-pointer", at, actor: { kind: "human", id: "owner" } },
      ),
    );
    const chat = () => ({
      ...f.input(),
      thread: parse(
        ThreadSchema,
        f.store.snapshot(["thread"]).thread?.find((row) => row.id === "thread"),
      ),
    });
    expect((await f.resolve(chat())).instructions).not.toContain('to: "chief"');
    f.change("thread", "thread", { kind: "manager" });
    expect((await f.resolve(chat())).instructions).toMatch(
      /Instructions: Handle units\n\nWhen you finish a piece of work .*to: "chief", idea: true/,
    );
  } finally {
    f.close();
  }
});
