import {
  type InteractionDraft,
  parse,
  type ShippingOperation,
  ShippingOperationSchema,
} from "@zoltbot/protocol";
import { commit, git } from "../../../gitkit/src/git.js";
import {
  githubRemotes,
  publishCommit,
  publishHash,
  pushExecution,
  remoteHead,
  validateBranch,
} from "../../../gitkit/src/publish.js";
import type { ShippingProposals } from "./proposals.js";
import type { ShippingContext } from "./state.js";
import { now, shippingState } from "./state.js";

export interface PublishInput {
  remote: string;
  branch: string;
  baseBranch: string;
  title: string;
  body: string;
  draft: boolean;
}
export interface PublishProposal extends PublishInput {
  taskId: string;
  revision: number;
  repository: string;
  repositoryId: string;
  account: string;
  head: string;
  base: string;
  targetBase: string;
  remoteHead: string;
  cwd: string;
  executionHash: string;
  files: string;
  commits: string;
  dirty: boolean;
  snapshotNumber?: number;
}
export function shippingPublishing(
  context: ShippingContext,
  proposals: ShippingProposals,
  requestApproval: (draft: InteractionDraft, id: string) => Promise<unknown>,
) {
  const state = shippingState(context);
  const readRemote = context.publishing?.remoteHead ?? remoteHead;
  const push = context.publishing?.publishCommit ?? publishCommit;
  async function preview(id: string, input: PublishInput): Promise<PublishProposal> {
    const task = state.task(id),
      binding = state.binding(id);
    if (!["review", "completed"].includes(task.state)) throw new Error("shipping_review_required");
    const workspace = await state.workspace(id);
    await validateBranch(workspace.cwd, input.branch);
    if (!input.baseBranch || input.baseBranch === input.branch || /[\r\n\0]/.test(input.baseBranch))
      throw new Error("shipping_base_invalid");
    await git(workspace.cwd, ["check-ref-format", `refs/heads/${input.baseBranch}`]);
    const remotes = await githubRemotes(workspace.cwd),
      remote = remotes.find((r) => r.name === input.remote);
    if (!remote) throw new Error("github_remote_unsupported");
    const repository = await context.client.repository(remote.repository);
    const targetBase = await context.client.branch(repository.name, input.baseBranch);
    const account = await context.client.account();
    if (!repository.canPush) throw new Error("github_access_denied");
    if (
      binding &&
      (binding.repositoryId !== repository.id ||
        binding.account !== account ||
        binding.branch !== input.branch ||
        binding.baseBranch !== input.baseBranch ||
        binding.readOnly)
    )
      throw new Error("shipping_binding_changed");
    const review = context.store
      .snapshot(["settings"])
      .settings?.find((row) => row.key === `worktree.review.${id}`)?.value as
      | { head?: string; base?: string; revision?: number }
      | undefined;
    const head = await commit(workspace.cwd, "HEAD");
    if (
      !review?.head ||
      review.head !== head ||
      review.revision !== task.revision ||
      review.base !== workspace.baseCommit
    )
      throw new Error("shipping_review_commit_required");
    try {
      await git(workspace.cwd, ["merge-base", "--is-ancestor", targetBase, head]);
    } catch {
      throw new Error("shipping_target_update_required");
    }
    const executionHash = await pushExecution(workspace.cwd);
    const remoteSha = await readRemote(workspace.cwd, repository.name, input.branch);
    if (remoteSha && remoteSha !== head) {
      if (!binding?.publishedHead || remoteSha !== binding.publishedHead)
        throw new Error("shipping_remote_changed");
      await git(workspace.cwd, ["merge-base", "--is-ancestor", remoteSha, head]);
    } else if (remoteSha && !binding?.publishedHead && binding?.snapshot?.head !== remoteSha)
      throw new Error("shipping_branch_exists");
    if (binding?.snapshot) {
      const snapshot = await state.refresh(id);
      if (
        snapshot.state !== "OPEN" ||
        snapshot.head !== remoteSha ||
        snapshot.headRepository.toLowerCase() !== repository.name.toLowerCase()
      )
        throw new Error("shipping_remote_changed");
    }
    const files = await git(workspace.cwd, [
      "diff",
      "--no-ext-diff",
      "--stat",
      targetBase,
      head,
      "--",
    ]);
    const commits = await git(workspace.cwd, ["log", "--format=%h %s", `${targetBase}..${head}`]);
    if (!commits) throw new Error("shipping_no_changes");
    return {
      ...input,
      taskId: id,
      revision: task.revision,
      repository: repository.name,
      repositoryId: repository.id,
      account,
      head,
      base: workspace.baseCommit,
      targetBase,
      remoteHead: remoteSha,
      cwd: workspace.cwd,
      executionHash,
      files: files.slice(0, 16000),
      commits: commits.slice(0, 8000),
      dirty: Boolean(await git(workspace.cwd, ["status", "--porcelain"])),
      ...(binding?.snapshot ? { snapshotNumber: binding.snapshot.number } : {}),
    };
  }
  async function approve(proposal: PublishProposal, fingerprint: string) {
    const approvalId = `shipping-push-${fingerprint}`;
    const approval = context.store.record("interaction", approvalId);
    if (!approval) {
      const task = state.task(proposal.taskId);
      if (!task.ownerAgentId || !task.threadId) throw new Error("shipping_task_unavailable");
      await requestApproval(
        {
          id: approvalId,
          agentId: task.ownerAgentId,
          threadId: task.threadId,
          taskId: task.id,
          type: "approval",
          title: "Publish reviewed code to GitHub",
          urgency: "background",
          nativeRef: "host:workspace",
          chain: [{ kind: "human", id: "local-owner" }],
          context: {
            cwd: proposal.cwd,
            toolName: "github_publish",
            toolKind: "execute",
            command: `git push https://github.com/${proposal.repository}.git ${proposal.head}:refs/heads/${proposal.branch}`,
            markdown:
              "Publishes the displayed reviewed commit. Git may execute configured credential helpers, reference hooks and pre-push hooks. Approval applies only to this proposal and Git configuration.",
            toolInput: {
              fingerprint,
              executionHash: proposal.executionHash,
              worktreeExecution: true,
            },
          },
          items: [
            {
              id: "execute",
              prompt: "Allow this Git execution and publication?",
              choices: [{ id: "allow_once" }, { id: "reject_once" }],
            },
          ],
        },
        `request:${approvalId}`,
      );
      return { pendingApproval: approvalId };
    }
    const resolution = approval.resolution as
      | { action?: string; choice?: string; automatic?: boolean }
      | undefined;
    if (
      approval.state !== "answered" ||
      resolution?.action !== "accept" ||
      resolution.choice !== "allow_once" ||
      resolution.automatic
    )
      throw new Error("shipping_execution_approval_required");
    return undefined;
  }
  async function execute(id: string, fingerprint: string, commandId: string) {
    const opId = commandId;
    const stored = context.store.record("shippingOperation", opId);
    let operation: ShippingOperation;
    if (stored) {
      operation = parse(ShippingOperationSchema, stored);
      if (
        operation.taskId !== id ||
        operation.fingerprint !== fingerprint ||
        operation.kind !== "publish"
      )
        throw new Error("shipping_operation_conflict");
      if (operation.state === "done") return operation.result;
    } else {
      const proposal = proposals.get(id, "publish", fingerprint) as unknown as PublishProposal;
      const current = await preview(id, proposal);
      if (publishHash(current) !== publishHash(proposal)) throw new Error("shipping_preview_stale");
      operation = {
        id: opId,
        taskId: id,
        kind: "publish",
        fingerprint,
        proposal,
        state: "awaiting_approval",
        updatedAt: now(),
      };
      await state.save("shippingOperation", operation);
    }
    const proposal = operation.proposal as PublishProposal;
    const save = async (stage: ShippingOperation["state"], result?: unknown) => {
      operation = {
        ...operation,
        state: stage,
        ...(result === undefined ? {} : { result }),
        updatedAt: now(),
      };
      await state.save("shippingOperation", operation);
    };
    try {
      if (operation.state === "awaiting_approval") {
        const current = await preview(id, proposal);
        if (publishHash(current) !== publishHash(proposal))
          throw new Error("shipping_preview_stale");
        const pending = await approve(proposal, fingerprint);
        if (pending) return pending;
        await save("approved");
      }
      if ((await context.client.account()) !== proposal.account)
        throw new Error("github_account_changed");
      const destination = await context.client.repository(proposal.repository);
      if (destination.id !== proposal.repositoryId || !destination.canPush)
        throw new Error("github_identity_changed");
      const workspace = await state.workspace(id);
      if (workspace.cwd !== proposal.cwd || state.task(id).revision !== proposal.revision)
        throw new Error("shipping_preview_stale");
      let remoteSha = await readRemote(proposal.cwd, proposal.repository, proposal.branch);
      if (remoteSha !== proposal.head) {
        if (["pushed", "creating"].includes(operation.state) || remoteSha !== proposal.remoteHead)
          throw new Error("shipping_remote_changed");
        if (
          (await commit(proposal.cwd, "HEAD")) !== proposal.head ||
          (await pushExecution(proposal.cwd)) !== proposal.executionHash
        )
          throw new Error("shipping_preview_stale");
        await save("pushing");
        await push(proposal.cwd, proposal.repository, proposal.branch, proposal.head, id);
        remoteSha = await readRemote(proposal.cwd, proposal.repository, proposal.branch);
        if (remoteSha !== proposal.head) throw new Error("shipping_push_uncertain");
      }
      await save("pushed");
      const remote = (await githubRemotes(proposal.cwd)).find((r) => r.name === proposal.remote);
      if (!remote || remote.repository.toLowerCase() !== proposal.repository.toLowerCase())
        throw new Error("shipping_binding_changed");
      const rows = await context.client.find(proposal.repository, proposal.branch);
      if (rows.length > 1) throw new Error("shipping_pr_ambiguous");
      let number = rows[0]?.number as number | undefined;
      if (!number) {
        // After an uncertain create, a read which finds nothing is not proof of failure.
        if (operation.creationStarted) throw new Error("shipping_creation_uncertain");
        operation = { ...operation, creationStarted: true };
        await save("creating");
        number = await context.client.create(proposal.repository, proposal);
      }
      const snapshot = await context.client.pull(proposal.repository, number);
      if (
        snapshot.repositoryId !== proposal.repositoryId ||
        snapshot.head !== proposal.head ||
        snapshot.baseBranch !== proposal.baseBranch ||
        snapshot.headBranch !== proposal.branch
      )
        throw new Error("shipping_remote_changed");
      await state.save("shipping", {
        id,
        taskId: id,
        repository: proposal.repository,
        repositoryId: proposal.repositoryId,
        account: proposal.account,
        remote: proposal.remote,
        remoteUrl: remote.url,
        branch: proposal.branch,
        baseBranch: proposal.baseBranch,
        publishedHead: proposal.head,
        snapshot,
        readOnly: false,
        updatedAt: now(),
      });
      const result = { url: snapshot.url, number: snapshot.number };
      await save("done", result);
      return result;
    } catch (error) {
      if (operation.state !== "awaiting_approval") await save("uncertain");
      throw error;
    }
  }
  return {
    preview,
    async propose(id: string, input: PublishInput) {
      const value = await preview(id, input);
      const check = await context.checkPublic(value);
      check(context.store.snapshot());
      return proposals.put(id, "publish", value as unknown as Record<string, unknown>);
    },
    execute,
  };
}
