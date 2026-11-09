import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { at } from "../../../../tools/fakes/src/runtime-fixture.js";
import {
  archiveSnapshot,
  clean,
  createReviewCommit,
  git,
  integrate,
  previewIntegration,
  previewReview,
} from "../../../gitkit/src/index.js";
import { taskRunner } from "../task-runner.js";
import { createArtifactBinding } from "./binding.js";
import { artifactFixture } from "./test-fixture.js";

it("keeps running worktrees clean and puts accepted artifacts on the reviewed branch through integration and archive", async () => {
  const f = await artifactFixture();
  const runner = taskRunner({
    store: f.store,
    publish() {},
    checkPublic: (v) => f.context.privacy.prepareData(v),
  });
  try {
    const hooks = path.join(f.root, "empty-hooks");
    await mkdir(hooks);
    await git(f.workspace, ["init", "-b", "main"], true);
    for (const [key, value] of [
      ["user.name", "Fixture"],
      ["user.email", "fixture@example.invalid"],
      ["core.hooksPath", hooks],
      ["commit.gpgsign", "false"],
      ["core.fsmonitor", "false"],
    ])
      await git(f.workspace, ["config", String(key), String(value)], true);
    await writeFile(path.join(f.workspace, "README.md"), "Fixture\n");
    await git(f.workspace, ["add", "README.md"], true);
    await git(f.workspace, ["commit", "-m", "Seed fixture"], true);
    const base = await git(f.workspace, ["rev-parse", "HEAD"]);
    const worktree = path.join(f.root, "worktree");
    await git(f.workspace, ["worktree", "add", "--detach", worktree, base], true);
    const first = await f.save("<h1>Accepted fixture</h1>");
    const binding = createArtifactBinding(worktree, worktree);
    f.change({
      type: "update",
      kind: "settings",
      id: "runtime.configuration.session",
      changes: { value: { launchManifest: { artifact: binding } } },
    });
    f.change({
      type: "create",
      kind: "workspace",
      value: {
        id: "artifact-workspace",
        projectId: "artifact-project",
        kind: "worktree",
        path: worktree,
        repoRoot: f.workspace,
        baseRef: base,
        state: "active",
        createdAt: at,
      },
    });
    f.change({
      type: "create",
      kind: "task",
      value: {
        id: "artifact-task",
        projectId: "artifact-project",
        rootId: "artifact-task",
        node: { type: "project", id: "artifact-project" },
        title: "Artifact fixture",
        brief: "Build a page",
        acceptance: "Page saved",
        expectedDeliverable: "Page",
        ownerAgentId: "profile",
        threadId: "thread",
        workspaceMode: "worktree",
        workspaceId: "artifact-workspace",
        state: "queued",
        revision: 1,
        attempt: 1,
        maxAttempts: 1,
        reviewRequired: true,
        executionLocation: "local",
        createdBy: { kind: "human", id: "fixture" },
        createdAt: at,
        updatedAt: at,
      },
    });
    f.change({
      type: "update",
      kind: "thread",
      id: "thread",
      changes: { kind: "task", taskId: "artifact-task" },
    });
    f.change({ type: "transition", kind: "task", id: "artifact-task", to: "running", revision: 1 });
    expect((await f.save("<h1>Accepted fixture</h1>")).versionId).toBe(first.versionId);
    await clean(worktree);
    f.change({
      type: "submitResult",
      id: "artifact-task",
      revision: 1,
      status: "done",
      summary: "Page saved",
      files: [],
    });
    await runner.api(
      "task.review",
      { id: "artifact-task", revision: 1, confirmed: true, decision: "accept" },
      "artifact-accept",
    );
    expect(f.store.record("task", "artifact-task")?.state).toBe("completed");
    expect(
      await readFile(path.join(worktree, ".zoltbot/artifacts/sample/current/index.html"), "utf8"),
    ).toBe("<h1>Accepted fixture</h1>");
    await clean(f.workspace);
    const review = await createReviewCommit(
      await previewReview(worktree, base),
      "Accept fixture artifact",
      true,
    );
    expect(
      await git(worktree, ["show", `${review.head}:.zoltbot/artifacts/sample/current/index.html`]),
    ).toBe("<h1>Accepted fixture</h1>");
    await integrate(await previewIntegration(worktree, f.workspace, review.head), true);
    expect(
      await readFile(
        path.join(f.workspace, ".zoltbot/artifacts/sample/current/index.html"),
        "utf8",
      ),
    ).toBe("<h1>Accepted fixture</h1>");
    expect((await archiveSnapshot(worktree, base, path.join(f.root, "archive"))).verified).toBe(
      true,
    );
  } finally {
    runner.close();
    f.close();
  }
});
