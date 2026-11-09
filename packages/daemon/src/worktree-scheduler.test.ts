import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { handle } from "@zoltbot/core";
import { expect, test } from "vitest";
import { at, runtimeFixture } from "../../../tools/fakes/src/runtime-fixture.js";
import { git } from "../../gitkit/src/index.js";
import { InteractionEngine } from "./interaction-engine.js";
import { taskRunner } from "./task-runner.js";
import { worktreeService } from "./worktree-service.js";

test("isolated tasks run together while shared-folder tasks serialize", async () => {
  const f = await runtimeFixture();
  try {
    const root = path.join(f.root, "repository");
    await mkdir(root);
    await git(root, ["init"], true);
    await git(root, ["config", "user.name", "Test"], true);
    await git(root, ["config", "user.email", "test@example.invalid"], true);
    await writeFile(path.join(root, "file"), "base\n");
    await git(root, ["add", "file"], true);
    await git(root, ["commit", "-m", "base"], true);
    f.store.dispatch("project", (state) =>
      handle(
        state,
        {
          type: "create",
          kind: "project",
          value: {
            id: "project",
            name: "Project",
            goal: "",
            instructions: "",
            constraints: "",
            roots: [{ path: root, label: "Code", repoRoot: root }],
            hierarchyDepth: 1,
            tags: [],
            requireCodeReview: false,
            skipFinalGateWhenReviewed: false,
            archived: false,
            createdAt: at,
          },
        },
        { commandId: "project", at, actor: { kind: "human", id: "owner" } },
      ),
    );
    const wakes: string[] = [];
    const runner = taskRunner({
      store: f.store,
      worktrees: worktreeService(f.root, f.store),
      publish() {},
      checkPublic: async () => () => {},
      wake: async (id) => {
        wakes.push(id);
      },
    });
    for (const [index, workspaceMode] of ["worktree", "worktree", "shared", "shared"].entries()) {
      await runner.api(
        "task.create",
        {
          title: `Task ${index}`,
          brief: "Make change",
          profileId: "profile",
          node: { type: "project", id: "project" },
          workspaceMode,
        },
        `create-${index}`,
      );
      await runner.schedule();
    }
    const tasks = f.store.snapshot(["task"]).task ?? [];
    expect(
      tasks.filter((row) => row.workspaceMode === "worktree" && row.state === "running"),
    ).toHaveLength(2);
    expect(
      tasks.filter((row) => row.workspaceMode === "shared" && row.state === "running"),
    ).toHaveLength(1);
    expect(
      tasks.filter((row) => row.workspaceMode === "shared" && row.state === "queued"),
    ).toHaveLength(1);
    expect(
      new Set(tasks.filter((row) => row.workspaceMode === "worktree").map((row) => row.workspaceId))
        .size,
    ).toBe(2);
    expect(wakes).toHaveLength(3);
    expect(
      f.store.database.prepare("SELECT COUNT(*) AS n FROM managed_worktree_operations").get(),
    ).toEqual({ n: 2 });
    runner.close();
  } finally {
    f.close();
  }
});

test("failed preparation keeps the brief queued and explicit retry binds the same task", async () => {
  const f = await runtimeFixture();
  try {
    const { chmod } = await import("node:fs/promises");
    const root = path.join(f.root, "repository");
    await mkdir(root);
    await git(root, ["init"], true);
    await git(root, ["config", "user.name", "Test"], true);
    await git(root, ["config", "user.email", "test@example.invalid"], true);
    await writeFile(path.join(root, "file"), "base\n");
    await git(root, ["add", "file"], true);
    await git(root, ["commit", "-m", "base"], true);
    const hook = path.join(root, ".git/hooks/post-checkout");
    await writeFile(hook, "#!/bin/sh\nprintf setup-ran > setup-result\n");
    await chmod(hook, 0o755);
    f.store.dispatch("project", (state) =>
      handle(
        state,
        {
          type: "create",
          kind: "project",
          value: {
            id: "project",
            name: "Project",
            goal: "",
            instructions: "",
            constraints: "",
            roots: [{ path: root, label: "Code", repoRoot: root }],
            hierarchyDepth: 1,
            tags: [],
            requireCodeReview: false,
            skipFinalGateWhenReviewed: false,
            archived: false,
            createdAt: at,
          },
        },
        { commandId: "project", at, actor: { kind: "human", id: "owner" } },
      ),
    );
    const engine = new InteractionEngine({ store: f.store, publish() {} });
    const runner = taskRunner({
      store: f.store,
      worktrees: worktreeService(f.root, f.store),
      publish() {},
      checkPublic: async () => () => {},
      requestApproval: async (draft, commandId) => engine.request(draft, commandId),
    });
    const result = (await runner.api(
      "task.create",
      {
        title: "Saved brief",
        brief: "Keep this goal",
        profileId: "profile",
        node: { type: "project", id: "project" },
        workspaceMode: "worktree",
      },
      "blocked-create",
    )) as { id: string };
    await runner.schedule();
    expect(f.store.record("task", result.id)).toMatchObject({
      state: "queued",
      brief: "Keep this goal",
      workspaceMode: "worktree",
    });
    expect(f.store.record("task", result.id)?.holdReason).toContain("Approve setup in the inbox");
    expect(f.store.snapshot(["workspace"]).workspace ?? []).toHaveLength(0);
    const approval = f.store
      .snapshot(["interaction"])
      .interaction?.find((row) => row.taskId === result.id);
    expect(approval?.state).toBe("pending");
    f.store.dispatch("approve-setup", (state) =>
      handle(
        state,
        {
          type: "answer",
          id: String(approval?.id),
          version: 1,
          answer: {
            action: "accept",
            choice: "allow_once",
            by: { kind: "human", id: "owner" },
            at,
          },
        },
        { commandId: "approve-setup", at, actor: { kind: "human", id: "owner" } },
      ),
    );
    await runner.api("task.prepareWorkspace", { id: result.id }, "retry-prepare");
    await runner.schedule();
    expect(f.store.record("task", result.id)).toMatchObject({
      state: "running",
      brief: "Keep this goal",
    });
    expect(f.store.snapshot(["task"]).task).toHaveLength(1);
    const workspaceId = f.store.record("task", result.id)?.workspaceId;
    const cwd = String(f.store.record("workspace", String(workspaceId))?.path);
    expect(await readFile(path.join(cwd, "setup-result"), "utf8")).toBe("setup-ran");
    runner.close();
  } finally {
    f.close();
  }
});
