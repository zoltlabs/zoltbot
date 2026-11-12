import { writeFile } from "node:fs/promises";
import path from "node:path";
import { finishTaskTurn, handle, startTask } from "@zoltbot/core";
import { expect, test, vi } from "vitest";
import { git } from "../../../gitkit/src/git.js";
import { shippingFixture, testContext } from "./test-fixture.js";

// These cases clone, commit and push real disposable Git repositories repeatedly.
vi.setConfig({ testTimeout: 45_000 });

const input = {
  id: "task",
  remote: "origin",
  branch: "zoltbot/task",
  baseBranch: "main",
  title: "Fix timeout",
  body: "Tested in disposable fixture",
  draft: true,
};
async function publish(f: Awaited<ReturnType<typeof shippingFixture>>, commandId = "publish") {
  const preview = (await f.service.api("shipping.publishPreview", input)) as {
    fingerprint: string;
  };
  const params = { id: "task", fingerprint: preview.fingerprint, confirmed: true };
  expect(await f.service.api("shipping.publish", params, commandId)).toHaveProperty(
    "pendingApproval",
  );
  await f.approve();
  return { params, preview };
}
async function link(f: Awaited<ReturnType<typeof shippingFixture>>) {
  const preview = (await f.service.api("shipping.linkPreview", {
    id: "task",
    url: f.snapshot.url,
  })) as { fingerprint: string };
  await f.service.api(
    "shipping.link",
    { id: "task", fingerprint: preview.fingerprint, confirmed: true },
    "link",
  );
}
test("publishes exact reviewed SHA, approval required, PR durable and retries do not duplicate writes", async () => {
  const f = await shippingFixture();
  try {
    const { params } = await publish(f);
    await expect(
      f.service.api("shipping.publish", { ...params, confirmed: false }, "publish"),
    ).rejects.toThrow("confirmation_required");
    expect(await f.service.api("shipping.publish", params, "publish")).toHaveProperty(
      "number",
      482,
    );
    expect(await git(f.repo, ["--git-dir", f.remote, "rev-parse", "refs/heads/zoltbot/task"])).toBe(
      f.head,
    );
    expect(await git(f.binding.cwd, ["symbolic-ref", "-q", "HEAD"]).catch(() => "detached")).toBe(
      "detached",
    );
    await f.service.api("shipping.publish", params, "publish");
    expect(f.state.pushes).toBe(1);
    expect(f.state.creates).toBe(1);
    expect(f.store.record("task", "task")?.state).toBe("review");
    f.store.rebuild();
    expect(f.store.record("shipping", "task")?.publishedHead).toBe(f.head);
  } finally {
    await f.close();
  }
});
test("changed files/configuration or review revision invalidates a publishing preview", async () => {
  const f = await shippingFixture();
  try {
    const { params } = await publish(f);
    await git(f.binding.cwd, ["config", "test.changed", "yes"], true);
    await expect(f.service.api("shipping.publish", params, "publish")).rejects.toThrow(
      "shipping_preview_stale",
    );
    expect(f.state.pushes).toBe(0);
  } finally {
    await f.close();
  }
});
test("uncertain PR creation reconciles after daemon-service restart without a second push or PR", async () => {
  const f = await shippingFixture();
  let restarted: ReturnType<typeof f.createService> | undefined;
  try {
    const { params } = await publish(f);
    f.state.failCreateAfterWrite = true;
    await expect(f.service.api("shipping.publish", params, "publish")).rejects.toThrow(
      "github_request_failed",
    );
    f.service.close();
    restarted = f.createService();
    await restarted.api("shipping.publish", params, "publish");
    expect(f.state.creates).toBe(1);
    expect(f.state.pushes).toBe(1);
    expect(f.store.record("shippingOperation", "publish")?.state).toBe("done");
  } finally {
    restarted?.close();
    await f.close();
  }
});
test("link validates repository and marks a foreign head observation-only", async () => {
  const f = await shippingFixture();
  try {
    await expect(
      f.service.api("shipping.linkPreview", {
        id: "task",
        url: "https://github.com/other/repo/pull/1",
      }),
    ).rejects.toThrow("shipping_repository_mismatch");
    f.snapshot.head = "b".repeat(40);
    await link(f);
    expect(f.store.record("shipping", "task")?.readOnly).toBe(true);
    await expect(f.service.api("shipping.publishPreview", input)).rejects.toThrow(
      "shipping_binding_changed",
    );
    expect(f.state.pushes).toBe(0);
  } finally {
    await f.close();
  }
});
test("selected feedback reopens accepted task exactly once with native thread and worktree preserved", async () => {
  const f = await shippingFixture();
  try {
    await link(f);
    f.store.dispatch("accept", (s) =>
      handle(
        s,
        { type: "review", id: "task", revision: 1, decision: "accept" },
        testContext("accept"),
      ),
    );
    f.store.dispatch("native-session", (state) =>
      handle(
        state,
        {
          type: "create",
          kind: "session",
          value: {
            id: "task-session",
            threadId: "task:thread",
            provider: "fixture",
            nativeId: "provider-session-123",
            cwd: f.binding.cwd,
            state: "starting",
            capabilities: {},
            generation: 1,
            startedAt: new Date().toISOString(),
          },
        },
        testContext("native-session"),
      ),
    );
    const original = f.store.record("task", "task");
    const preview = (await f.service.api("shipping.feedbackPreview", {
      id: "task",
      selected: ["thread-1", "check:123"],
      note: "Keep existing API",
    })) as { fingerprint: string; text: string };
    expect(preview.text).toContain("Cancellation case failed");
    const params = { id: "task", fingerprint: preview.fingerprint, confirmed: true };
    await f.service.api("shipping.feedback", params, "feedback");
    await f.service.api("shipping.feedback", params, "feedback");
    const task = f.store.record("task", "task");
    expect(task?.revision).toBe(2);
    expect(task?.state).toBe("queued");
    expect(task?.threadId).toBe(original?.threadId);
    expect(task?.workspaceId).toBe(original?.workspaceId);
    expect(task?.brief).toContain("Keep existing API");
    expect(f.store.record("session", "task-session")?.nativeId).toBe("provider-session-123");
    expect(f.store.snapshot(["taskResult"]).taskResult).toHaveLength(1);
  } finally {
    await f.close();
  }
});
test("busy feedback waits until result boundary and changed reviewer content is held", async () => {
  const f = await shippingFixture();
  try {
    await link(f);
    f.store.dispatch("revise", (s) =>
      handle(
        s,
        { type: "review", id: "task", revision: 1, decision: "changes", feedback: "Continue" },
        testContext("revise"),
      ),
    );
    f.store.dispatch("start2", (s) => startTask(s, "task", 2, testContext("start2")));
    const preview = (await f.service.api("shipping.feedbackPreview", {
      id: "task",
      selected: ["thread-1"],
      note: "",
    })) as { fingerprint: string };
    await f.service.api(
      "shipping.feedback",
      { id: "task", fingerprint: preview.fingerprint, confirmed: true },
      "feedback",
    );
    expect(f.store.record("task", "task")?.revision).toBe(2);
    f.snapshot.threads = f.snapshot.threads.map((t) => ({ ...t, body: "Changed feedback" }));
    f.store.dispatch("finish2", (s) =>
      finishTaskTurn(s, "task", 2, { status: "completed", text: "Done" }, testContext("finish2")),
    );
    await f.service.tick();
    expect(f.store.record("task", "task")?.revision).toBe(2);
    expect(f.store.snapshot(["shippingFeedback"]).shippingFeedback?.[0]?.state).toBe("held");
  } finally {
    await f.close();
  }
});
test("oversized feedback is refused visibly; no batch or new revision", async () => {
  const f = await shippingFixture();
  try {
    await link(f);
    f.snapshot.threads = f.snapshot.threads.map((t) => ({ ...t, body: "x".repeat(16000) }));
    await expect(
      f.service.api("shipping.feedbackPreview", { id: "task", selected: ["thread-1"], note: "" }),
    ).rejects.toThrow("shipping_feedback_too_large");
    expect(f.store.snapshot(["shippingFeedback"]).shippingFeedback ?? []).toHaveLength(0);
  } finally {
    await f.close();
  }
});
test("merge is head-fenced, separate from acceptance, and uncertain success reconciles", async () => {
  const f = await shippingFixture();
  try {
    const { params } = await publish(f);
    await f.service.api("shipping.publish", params, "publish");
    await expect(
      f.service.api("shipping.mergePreview", { id: "task", method: "SQUASH" }),
    ).rejects.toThrow("shipping_merge_unavailable");
    f.store.dispatch("accept", (s) =>
      handle(
        s,
        { type: "review", id: "task", revision: 1, decision: "accept" },
        testContext("accept"),
      ),
    );
    f.snapshot.draft = false;
    f.snapshot.mergeState = "CLEAN";
    const preview = (await f.service.api("shipping.mergePreview", {
      id: "task",
      method: "SQUASH",
    })) as { fingerprint: string };
    f.snapshot.head = "c".repeat(40);
    await expect(
      f.service.api(
        "shipping.merge",
        { id: "task", fingerprint: preview.fingerprint, confirmed: true },
        "merge",
      ),
    ).rejects.toThrow("shipping_preview_stale");
    expect(f.state.merges).toBe(0);
    f.snapshot.head = f.head;
    f.state.failMergeAfterWrite = true;
    const next = (await f.service.api("shipping.mergePreview", {
      id: "task",
      method: "SQUASH",
    })) as { fingerprint: string };
    const values = { id: "task", fingerprint: next.fingerprint, confirmed: true };
    await expect(f.service.api("shipping.merge", values, "merge2")).rejects.toThrow(
      "github_request_failed",
    );
    await f.service.api("shipping.merge", values, "merge2");
    expect(f.state.merges).toBe(1);
    expect(f.store.record("task", "task")?.state).toBe("completed");
    expect(await git(f.repo, ["rev-parse", "HEAD"])).toBe(f.base);
  } finally {
    await f.close();
  }
});
test("newer uncommitted changes are not published and remote/account drift refuses writes", async () => {
  const f = await shippingFixture();
  try {
    await writeFile(path.join(f.binding.cwd, "file.txt"), "unreviewed draft\n");
    const { params, preview } = await publish(f);
    expect(preview).toHaveProperty("dirty", true);
    f.state.account = "another-user";
    await expect(f.service.api("shipping.publish", params, "publish")).rejects.toThrow(
      "shipping_preview_stale",
    );
    expect(f.state.pushes).toBe(0);
  } finally {
    await f.close();
  }
});

test("feedback revision publishes to the existing PR without creating another PR", async () => {
  const f = await shippingFixture();
  try {
    const first = await publish(f);
    await f.service.api("shipping.publish", first.params, "publish");
    const feedback = (await f.service.api("shipping.feedbackPreview", {
      id: "task",
      selected: ["thread-1"],
      note: "",
    })) as { fingerprint: string };
    await f.service.api(
      "shipping.feedback",
      { id: "task", fingerprint: feedback.fingerprint, confirmed: true },
      "feedback",
    );
    f.store.dispatch("start-revision2", (s) =>
      startTask(s, "task", 2, testContext("start-revision2")),
    );
    await writeFile(path.join(f.binding.cwd, "file.txt"), "fixed with cancellation coverage\n");
    await git(f.binding.cwd, ["add", "."], true);
    await git(f.binding.cwd, ["commit", "-m", "Address review"], true);
    const head = await git(f.binding.cwd, ["rev-parse", "HEAD"]);
    f.store.dispatch("review2", (s) =>
      handle(
        s,
        {
          type: "update",
          kind: "settings",
          id: "worktree.review.task",
          changes: { value: { head, base: f.base, revision: 2 } },
        },
        testContext("review2"),
      ),
    );
    f.store.dispatch("finish-revision2", (s) =>
      finishTaskTurn(
        s,
        "task",
        2,
        { status: "completed", text: "Covered cancellation" },
        testContext("finish-revision2"),
      ),
    );
    const second = await publish(f, "publish2");
    await f.service.api("shipping.publish", second.params, "publish2");
    expect(f.state.pushes).toBe(2);
    expect(f.state.creates).toBe(1);
    expect(f.store.record("shipping", "task")?.publishedHead).toBe(head);
    expect(f.snapshot.number).toBe(482);
  } finally {
    await f.close();
  }
});

test("pending publication approval survives service restart and cannot be bypassed", async () => {
  const f = await shippingFixture();
  let restarted: ReturnType<typeof f.createService> | undefined;
  try {
    const pending = (await f.service.api("shipping.publishPreview", input)) as {
      fingerprint: string;
    };
    const params = { id: "task", fingerprint: pending.fingerprint, confirmed: true };
    await f.service.api("shipping.publish", params, "publish");
    f.service.close();
    restarted = f.createService();
    await expect(restarted.api("shipping.publish", params, "publish")).rejects.toThrow(
      "shipping_execution_approval_required",
    );
    expect(f.store.record("shippingOperation", "publish")?.state).toBe("awaiting_approval");
    expect(f.state.pushes).toBe(0);
    await f.approve();
    await restarted.api("shipping.publish", params, "publish");
    expect(f.state.pushes).toBe(1);
    expect(f.state.creates).toBe(1);
  } finally {
    restarted?.close();
    await f.close();
  }
});

test("GitHub branch drift never causes a force-push and queued PRs cannot merge directly", async () => {
  const f = await shippingFixture();
  try {
    const first = await publish(f);
    await f.service.api("shipping.publish", first.params, "publish");
    const tree = await git(f.repo, ["rev-parse", `${f.base}^{tree}`]);
    const remoteCommit = await git(
      f.repo,
      ["commit-tree", tree, "-p", f.head, "-m", "Teammate update"],
      true,
    );
    await git(f.repo, ["push", f.remote, `${remoteCommit}:refs/heads/zoltbot/task`], true);
    await expect(f.service.api("shipping.publishPreview", input)).rejects.toThrow(
      "shipping_remote_changed",
    );
    expect(f.state.pushes).toBe(1);
    f.snapshot.queuePosition = 2;
    f.snapshot.draft = false;
    f.snapshot.mergeState = "CLEAN";
    f.store.dispatch("accept", (s) =>
      handle(
        s,
        { type: "review", id: "task", revision: 1, decision: "accept" },
        testContext("accept"),
      ),
    );
    await expect(
      f.service.api("shipping.mergePreview", { id: "task", method: "SQUASH" }),
    ).rejects.toThrow("shipping_merge_unavailable");
    expect(f.state.merges).toBe(0);
  } finally {
    await f.close();
  }
});

test("invalid base branches are rejected before publishing any code", async () => {
  const f = await shippingFixture();
  try {
    await expect(
      f.service.api("shipping.publishPreview", { ...input, baseBranch: "missing-base" }),
    ).rejects.toThrow("github_base_unavailable");
    expect(f.state.pushes).toBe(0);
    expect(f.state.creates).toBe(0);
    expect(f.store.snapshot(["shippingOperation"]).shippingOperation ?? []).toHaveLength(0);
    const setup = (await f.service.api("shipping.setup", { id: "task" })) as {
      remotes: { name: string }[];
    };
    expect(setup.remotes[0]?.name).toBe("origin");
  } finally {
    await f.close();
  }
});
