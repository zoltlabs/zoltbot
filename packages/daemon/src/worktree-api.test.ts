import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createTask, finishTaskTurn, handle, startTask } from "@zoltbot/core";
import { expect, test } from "vitest";
import { at, runtimeFixture } from "../../../tools/fakes/src/runtime-fixture.js";
import { git } from "../../gitkit/src/index.js";
import { InteractionEngine } from "./interaction-engine.js";
import { worktreeApi } from "./worktree-api.js";
import { worktreeService } from "./worktree-service.js";

test("task review commit uses durable human approval, acceptance stays separate from integration", async () => {
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
    const context = (commandId: string) => ({
      commandId,
      at,
      actor: { kind: "human" as const, id: "owner" },
    });
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
        context("project"),
      ),
    );
    const service = worktreeService(f.root);
    const binding = await service.prepare(
      f.store.snapshot(),
      { type: "project", id: "project" },
      "task",
    );
    f.store.dispatch("task", (state) =>
      createTask(
        state,
        {
          id: "task",
          title: "Fix",
          brief: "Fix file",
          profileId: "profile",
          node: { type: "project", id: "project" },
          workspace: {
            id: binding.operationId,
            path: binding.cwd,
            repoRoot: root,
            baseRef: binding.baseCommit,
          },
        },
        context("task"),
      ),
    );
    f.store.dispatch("start", (state) => startTask(state, "task", 1, context("start")));
    await writeFile(path.join(binding.cwd, "file"), "fixed\n");
    f.store.dispatch("finish", (state) =>
      finishTaskTurn(state, "task", 1, { status: "completed", text: "Fixed" }, context("finish")),
    );
    const engine = new InteractionEngine({ store: f.store, publish() {} });
    const api = worktreeApi({
      store: f.store,
      worktrees: service,
      publish() {},
      requestApproval: async (draft, commandId) => engine.request(draft, commandId),
    });
    const preview = (await api("task.reviewCommitPreview", { id: "task" })) as {
      fingerprint: string;
    };
    const params = { id: "task", fingerprint: preview.fingerprint, confirmed: true };
    const pending = (await api("task.reviewCommit", params, "commit")) as {
      pendingApproval: string;
    };
    const interaction = f.store.record("interaction", pending.pendingApproval);
    expect(interaction?.state).toBe("pending");
    await expect(api("task.reviewCommit", params, "commit")).rejects.toThrow(
      "review_execution_approval_required",
    );
    f.store.dispatch("approve", (state) =>
      handle(
        state,
        {
          type: "answer",
          id: pending.pendingApproval,
          version: 1,
          answer: {
            action: "accept",
            choice: "allow_once",
            by: { kind: "human", id: "owner" },
            at,
          },
        },
        context("approve"),
      ),
    );
    const result = (await api("task.reviewCommit", params, "commit")) as { head: string };
    expect(result.head).toBeTruthy();
    expect(await api("task.reviewCommit", params, "commit")).toMatchObject({ head: result.head });
    await expect(api("task.integrationPreview", { id: "task" })).rejects.toThrow(
      "accept_result_first",
    );
    f.store.dispatch("accept", (state) =>
      handle(
        state,
        { type: "review", id: "task", revision: 1, decision: "accept" },
        context("accept"),
      ),
    );
    const integration = (await api("task.integrationPreview", { id: "task" })) as {
      fingerprint: string;
    };
    const integrated = await api(
      "task.integrate",
      { id: "task", fingerprint: integration.fingerprint, confirmed: true },
      "integrate",
    );
    expect(integrated).toMatchObject({ head: result.head });
    expect(await git(root, ["rev-parse", "HEAD"])).toBe(result.head);
  } finally {
    f.close();
  }
});
