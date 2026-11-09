import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createTask, finishTaskTurn, handle, startTask } from "@zoltbot/core";
import type { ShippingSnapshot } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import { openStore } from "@zoltbot/store";
import type { GitHubClient } from "../../../github/src/client.js";
import { git } from "../../../gitkit/src/git.js";
import { InteractionEngine } from "../interaction-engine.js";
import { worktreeService } from "../worktree-service.js";
import { shippingService } from "./service.js";

export const testContext = (commandId: string) => ({
  commandId,
  at: new Date().toISOString(),
  actor: { kind: "human" as const, id: "owner" },
});
export async function seedShipping(store: Store, root: string) {
  const repo = path.join(root, "repo"),
    remote = path.join(root, "remote.git");
  await mkdir(repo, { recursive: true });
  await git(repo, ["init", "-b", "main"], true);
  await git(repo, ["config", "user.name", "Test"], true);
  await git(repo, ["config", "user.email", "test@example.invalid"], true);
  await writeFile(path.join(repo, "file.txt"), "base\n");
  await git(repo, ["add", "."], true);
  await git(repo, ["commit", "-m", "base"], true);
  const base = await git(repo, ["rev-parse", "HEAD"]);
  await git(repo, ["init", "--bare", remote], true);
  await git(
    repo,
    ["remote", "add", "origin", "https://github.com/example/shipping-fixture.git"],
    true,
  );
  const rows: ["agentDefinition" | "agent" | "project", Record<string, unknown>][] = [
    [
      "agentDefinition",
      {
        id: "fake",
        displayName: "Fixture",
        adapter: "reference",
        binaryNames: [],
        versionCommand: [],
        launch: { command: "fake", args: [], env: {} },
        testedVersions: "fixture",
        defaults: { permissionProfile: "read_only" },
        staticCapabilities: {},
        nativeSessionRoots: [],
        experimental: false,
      },
    ],
    [
      "agent",
      {
        id: "profile",
        name: "Fixture agent",
        avatar: "F",
        definitionId: "fake",
        kind: "profile",
        permissionProfile: "workspace_write",
        instructions: "",
        hidden: false,
        archived: false,
      },
    ],
    [
      "project",
      {
        id: "project",
        name: "Shipping project",
        goal: "",
        instructions: "",
        constraints: "",
        roots: [{ path: repo, label: "Code", repoRoot: repo }],
        hierarchyDepth: 1,
        tags: [],
        requireCodeReview: false,
        skipFinalGateWhenReviewed: false,
        archived: false,
        createdAt: new Date().toISOString(),
      },
    ],
  ];
  for (const [kind, value] of rows)
    store.dispatch(`seed:${kind}`, (state) =>
      handle(state, { type: "create", kind, value }, testContext(`seed:${kind}`)),
    );
  const worktrees = worktreeService(root, store);
  const binding = await worktrees.prepare(
    store.snapshot(),
    { type: "project", id: "project" },
    "task",
  );
  store.dispatch("create", (state) =>
    createTask(
      state,
      {
        id: "task",
        title: "Fix login timeout",
        brief: "Fix the login timeout",
        profileId: "profile",
        node: { type: "project", id: "project" },
        workspace: { id: binding.operationId, path: binding.cwd, repoRoot: repo, baseRef: base },
      },
      testContext("create"),
    ),
  );
  store.dispatch("start", (state) => startTask(state, "task", 1, testContext("start")));
  await writeFile(path.join(binding.cwd, "file.txt"), "fixed\n");
  await git(binding.cwd, ["add", "."], true);
  await git(binding.cwd, ["commit", "-m", "Fix timeout"], true);
  const head = await git(binding.cwd, ["rev-parse", "HEAD"]);
  store.dispatch("finish", (state) =>
    finishTaskTurn(
      state,
      "task",
      1,
      { status: "completed", text: "Fixed the timeout. Test fixture only." },
      testContext("finish"),
    ),
  );
  store.dispatch("review-evidence", (state) =>
    handle(
      state,
      {
        type: "create",
        kind: "settings",
        value: { key: "worktree.review.task", value: { head, base, revision: 1 } },
      },
      testContext("review-evidence"),
    ),
  );
  const state = {
    account: "fixture-user",
    number: 0,
    pushes: 0,
    creates: 0,
    merges: 0,
    failCreateAfterWrite: false,
    failMergeAfterWrite: false,
    failPull: false,
  };
  const snapshot: ShippingSnapshot = {
    number: 482,
    nodeId: "PR_fixture",
    repositoryId: "R_fixture",
    url: "https://github.com/example/shipping-fixture/pull/482",
    title: "Fix login timeout",
    state: "OPEN",
    draft: true,
    head,
    base,
    headBranch: "zoltbot/task",
    baseBranch: "main",
    headRepository: "example/shipping-fixture",
    mergeable: "MERGEABLE",
    mergeState: "BLOCKED",
    reviewDecision: "CHANGES_REQUESTED",
    canPush: true,
    canMerge: true,
    mergeMethods: ["MERGE", "SQUASH", "REBASE"],
    checks: [
      {
        id: "123",
        name: "unit tests",
        state: "FAILURE",
        sha: head,
        url: "https://github.com/example/shipping-fixture/actions/runs/123",
      },
    ],
    threads: [
      {
        id: "thread-1",
        author: "reviewer",
        path: "file.txt",
        line: 1,
        body: "Please cover cancellation in the test.",
        url: "https://github.com/example/shipping-fixture/pull/482#discussion_r1",
        resolved: false,
        outdated: false,
        kind: "thread",
      },
    ],
    complete: true,
    requirementsKnown: false,
    fetchedAt: new Date().toISOString(),
  };
  const client: GitHubClient = {
    async account() {
      return state.account;
    },
    async branch(_repository, branch) {
      if (branch !== "main") throw new Error("github_base_unavailable");
      return base;
    },
    async repository() {
      return {
        id: "R_fixture",
        name: "example/shipping-fixture",
        defaultBranch: "main",
        canPush: true,
        methods: ["MERGE", "SQUASH", "REBASE"],
      };
    },
    async pull() {
      if (state.failPull) throw new Error("github_request_failed");
      return structuredClone({ ...snapshot, fetchedAt: new Date().toISOString() });
    },
    async find() {
      return state.number ? [{ number: state.number, head: { ref: snapshot.headBranch } }] : [];
    },
    async create(_name, input) {
      state.creates++;
      state.number = 482;
      snapshot.title = input.title;
      snapshot.draft = input.draft;
      snapshot.headBranch = input.branch;
      if (state.failCreateAfterWrite) throw new Error("github_request_failed");
      return 482;
    },
    async merge(_name, _number, sha) {
      if (snapshot.head !== sha) throw new Error("github_head_changed");
      state.merges++;
      snapshot.state = "MERGED";
      if (state.failMergeAfterWrite) throw new Error("github_request_failed");
      return { sha };
    },
    async diagnostics() {
      return "file.txt:1 Cancellation case failed";
    },
  };
  const publishing = {
    async remoteHead(_cwd: string, _repository: string, branch: string) {
      try {
        return await git(repo, [
          "--git-dir",
          remote,
          "rev-parse",
          "--verify",
          `refs/heads/${branch}`,
        ]);
      } catch {
        return "";
      }
    },
    async publishCommit(cwd: string, _repository: string, branch: string, sha: string) {
      state.pushes++;
      await git(cwd, ["push", remote, `${sha}:refs/heads/${branch}`], true);
      snapshot.head = sha;
      snapshot.headBranch = branch;
    },
  };
  return { repo, remote, base, head, binding, worktrees, state, snapshot, client, publishing };
}
export async function shippingFixture() {
  await mkdir(".cache/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".cache/tests/shipping-"));
  const store = await openStore(path.join(root, "store.db"));
  const fixture = await seedShipping(store, root);
  const engine = new InteractionEngine({ store, publish() {} });
  const createService = () =>
    shippingService({
      store,
      ...fixture,
      publish() {},
      checkPublic: async () => () => {},
      wake: async () => {},
      requestApproval: async (draft, id) => engine.request(draft, id),
      pollMs: 60_000,
    });
  const service = createService();
  return {
    ...fixture,
    root,
    store,
    service,
    createService,
    async approve() {
      const interaction = store
        .snapshot(["interaction"])
        .interaction?.filter((i) => i.state === "pending")
        .at(-1);
      if (!interaction) throw new Error("approval_missing");
      store.dispatch(`approve:${interaction.id}`, (state) =>
        handle(
          state,
          {
            type: "answer",
            id: String(interaction.id),
            version: Number(interaction.version),
            answer: {
              action: "accept",
              choice: "allow_once",
              automatic: false,
              by: { kind: "human", id: "owner" },
              at: new Date().toISOString(),
            },
          },
          testContext(`approve:${interaction.id}`),
        ),
      );
    },
    async close() {
      service.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
