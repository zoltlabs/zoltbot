import { type InteractionDraft, parse, ShippingOperationSchema } from "@zoltbot/protocol";
import { type GitHubClient, githubClient, pullUrl } from "../../../github/src/client.js";
import { ghTransport } from "../../../github/src/transport.js";
import { git, repositoryLock } from "../../../gitkit/src/git.js";
import { githubRemotes, publishHash } from "../../../gitkit/src/publish.js";
import { shippingFeedback } from "./feedback.js";
import { ShippingProposals } from "./proposals.js";
import { type PublishInput, shippingPublishing } from "./publishing.js";
import { now, type ShippingContext, shippingState } from "./state.js";

export function shippingService(
  options: Omit<ShippingContext, "client"> & {
    client?: GitHubClient;
    requestApproval(draft: InteractionDraft, id: string): Promise<unknown>;
    pollMs?: number;
  },
) {
  let closed = false;
  const abort = new AbortController();
  const context: ShippingContext = {
    ...options,
    closed: () => closed,
    client:
      options.client ??
      githubClient((endpoint, method, body) => ghTransport(endpoint, method, body, abort.signal)),
  };
  const state = shippingState(context),
    proposals = new ShippingProposals();
  const publishing = shippingPublishing(context, proposals, options.requestApproval);
  const feedback = shippingFeedback(context, proposals);
  let ticking = false,
    nextPoll = Date.now() + 300000;
  async function tick() {
    if (closed || ticking) return;
    ticking = true;
    try {
      await feedback.tick();
      if (Date.now() >= nextPoll) {
        nextPoll = Date.now() + 300000;
        for (const binding of context.store.snapshot(["shipping"]).shipping ?? []) {
          const snapshot = binding.snapshot as { state?: string } | undefined;
          if (snapshot?.state === "OPEN")
            await repositoryLock(`shipping:${binding.id}`, () =>
              state.refresh(String(binding.id)),
            ).catch(() => {});
        }
      }
    } finally {
      ticking = false;
    }
  }
  const timer = setInterval(() => {
    void tick().catch(() => {});
  }, options.pollMs ?? 15000);
  timer.unref();
  const read = async (id: string) => {
    const task = state.task(id),
      binding = state.binding(id);
    let local: Record<string, unknown> = {};
    try {
      const workspace = await state.workspace(id);
      const review = context.store
        .snapshot(["settings"])
        .settings?.find((r) => r.key === `worktree.review.${id}`)?.value as
        | Record<string, unknown>
        | undefined;
      local = {
        head: await git(workspace.cwd, ["rev-parse", "HEAD"]),
        dirty: Boolean(await git(workspace.cwd, ["status", "--porcelain"])),
        reviewedHead: review?.revision === task.revision ? review.head : "",
        base: workspace.baseCommit,
      };
    } catch {
      local = { unavailable: true };
    }
    return {
      binding,
      local,
      taskState: task.state,
      revision: task.revision,
      feedback: (context.store.snapshot(["shippingFeedback"]).shippingFeedback ?? [])
        .filter((r) => r.taskId === id)
        .map(({ text: _text, ...metadata }) => metadata),
      operations: (context.store.snapshot(["shippingOperation"]).shippingOperation ?? [])
        .filter((r) => r.taskId === id)
        .map(({ proposal: _proposal, ...metadata }) => metadata),
    };
  };
  return {
    close() {
      closed = true;
      abort.abort();
      clearInterval(timer);
    },
    tick,
    async api(
      method: string,
      params: Record<string, unknown>,
      commandId?: string,
    ): Promise<unknown> {
      if (!method.startsWith("shipping.")) return undefined;
      if (closed) throw new Error("github_service_closed");
      const id = String(params.id);
      state.task(id);
      const mutation = [
        "shipping.link",
        "shipping.publish",
        "shipping.feedback",
        "shipping.cancelFeedback",
        "shipping.merge",
      ].includes(method);
      if (mutation && (!commandId || params.confirmed !== true))
        throw new Error("confirmation_required");
      if (method === "shipping.get") return read(id);
      // Feedback delivery acquires the task-review lock; shipping calls serialize separately.
      return repositoryLock(`shipping:${id}`, async () => {
        if (method === "shipping.setup") {
          const workspace = await state.workspace(id);
          const remotes = await githubRemotes(workspace.cwd),
            account = await context.client.account();
          const repositories = [];
          for (const remote of remotes)
            repositories.push({
              ...(await context.client.repository(remote.repository)),
              ...remote,
            });
          return {
            account,
            remotes: repositories,
            suggestedBranch: `zoltbot/${id.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 70)}-${publishHash(id).slice(0, 8)}`,
          };
        }
        if (method === "shipping.refresh") {
          await state.refresh(id);
          return read(id);
        }
        if (method === "shipping.linkPreview") {
          const reference = pullUrl(String(params.url));
          const account = await context.client.account(),
            snapshot = await context.client.pull(reference.repository, reference.number);
          const workspace = await state.workspace(id),
            remotes = await githubRemotes(workspace.cwd);
          const remote = remotes.find(
            (r) => r.repository.toLowerCase() === reference.repository.toLowerCase(),
          );
          if (!remote) throw new Error("shipping_repository_mismatch");
          const review = context.store
            .snapshot(["settings"])
            .settings?.find((r) => r.key === `worktree.review.${id}`)?.value as
            | { head?: string; revision?: number }
            | undefined;
          const writable =
            review?.head === snapshot.head &&
            review.revision === state.task(id).revision &&
            snapshot.headRepository.toLowerCase() === reference.repository.toLowerCase();
          const proposal = {
            account,
            snapshot,
            repository: reference.repository,
            repositoryId: snapshot.repositoryId,
            remote: remote.name,
            remoteUrl: remote.url,
            branch: snapshot.headBranch,
            baseBranch: snapshot.baseBranch,
            readOnly: !writable,
            ...(writable ? { publishedHead: snapshot.head } : {}),
          };
          const check = await context.checkPublic(proposal);
          check(context.store.snapshot());
          return proposals.put(id, "link", proposal);
        }
        if (method === "shipping.link") {
          if (context.store.receipt(commandId ?? ""))
            return context.store.receipt(commandId ?? "")?.result;
          const proposal = proposals.get(id, "link", String(params.fingerprint));
          if (state.binding(id)) throw new Error("shipping_already_linked");
          const snapshot = proposal.snapshot as { number: number; head: string; nodeId: string };
          const current = await context.client.pull(String(proposal.repository), snapshot.number);
          if (
            (await context.client.account()) !== proposal.account ||
            current.head !== snapshot.head ||
            current.nodeId !== snapshot.nodeId
          )
            throw new Error("shipping_preview_stale");
          return state.save(
            "shipping",
            { ...proposal, id, taskId: id, snapshot: current, updatedAt: now() },
            commandId,
          );
        }
        if (method === "shipping.publishPreview")
          return publishing.propose(id, params as unknown as PublishInput);
        if (method === "shipping.publish")
          return repositoryLock(`artifact-task-review:${id}`, () =>
            publishing.execute(id, String(params.fingerprint), commandId ?? ""),
          );
        if (method === "shipping.diagnostics") {
          const binding = state.binding(id),
            check = binding?.snapshot?.checks.find((c) => c.id === params.checkId);
          if (!binding || !check) throw new Error("shipping_check_unavailable");
          if ((await context.client.account()) !== binding.account)
            throw new Error("github_account_changed");
          const text = await context.client.diagnostics(binding.repository, check.id);
          const safe = await context.checkPublic(text);
          safe(context.store.snapshot());
          return { text, sha: check.sha, checkId: check.id };
        }
        if (method === "shipping.feedbackPreview")
          return feedback.preview(id, params.selected as string[], String(params.note ?? ""));
        if (method === "shipping.feedback")
          return feedback.send(id, String(params.fingerprint), commandId ?? "");
        if (method === "shipping.cancelFeedback")
          return feedback.cancel(id, String(params.batchId));
        if (method === "shipping.mergePreview") {
          const binding = state.binding(id),
            snapshot = await state.refresh(id);
          const task = state.task(id);
          if (
            !binding ||
            binding.readOnly ||
            task.state !== "completed" ||
            snapshot.queuePosition !== undefined ||
            snapshot.draft ||
            snapshot.state !== "OPEN" ||
            !snapshot.canMerge ||
            snapshot.mergeable !== "MERGEABLE" ||
            snapshot.mergeState !== "CLEAN" ||
            !snapshot.mergeMethods.includes(params.method as "MERGE")
          )
            throw new Error("shipping_merge_unavailable");
          const view = await read(id),
            local = view.local;
          if (
            local.unavailable ||
            local.dirty ||
            local.head !== snapshot.head ||
            local.reviewedHead !== snapshot.head
          )
            throw new Error("shipping_unpublished_changes");
          return proposals.put(id, "merge", {
            head: snapshot.head,
            nodeId: snapshot.nodeId,
            number: snapshot.number,
            baseBranch: snapshot.baseBranch,
            repository: binding.repository,
            account: binding.account,
            method: params.method,
            revision: task.revision,
          });
        }
        if (method === "shipping.merge") {
          const opId = commandId ?? "",
            existing = context.store.record("shippingOperation", opId);
          if (existing) {
            const op = parse(ShippingOperationSchema, existing);
            if (op.taskId !== id || op.fingerprint !== params.fingerprint)
              throw new Error("shipping_operation_conflict");
            if (op.state === "done") return op.result;
            const snapshot = await state.refresh(id);
            if (snapshot.state === "MERGED") {
              await state.save("shippingOperation", {
                ...op,
                state: "done",
                result: { merged: true },
                updatedAt: now(),
              });
              return { merged: true };
            }
            throw new Error("shipping_merge_uncertain_check_github");
          }
          const proposal = proposals.get(id, "merge", String(params.fingerprint));
          const snapshot = await state.refresh(id),
            binding = state.binding(id),
            view = await read(id);
          if (
            (await context.client.account()) !== proposal.account ||
            !binding ||
            snapshot.nodeId !== proposal.nodeId ||
            snapshot.head !== proposal.head ||
            snapshot.baseBranch !== proposal.baseBranch ||
            snapshot.mergeState !== "CLEAN" ||
            snapshot.queuePosition !== undefined ||
            snapshot.draft ||
            state.task(id).revision !== proposal.revision ||
            state.task(id).state !== "completed" ||
            view.local.dirty ||
            view.local.head !== proposal.head ||
            view.local.reviewedHead !== proposal.head
          )
            throw new Error("shipping_preview_stale");
          const operation = {
            id: opId,
            taskId: id,
            kind: "merge",
            fingerprint: String(params.fingerprint),
            proposal,
            state: "merging",
            updatedAt: now(),
          };
          await state.save("shippingOperation", operation);
          try {
            const result = await context.client.merge(
              binding.repository,
              snapshot.number,
              snapshot.head,
              String(proposal.method),
            );
            await state.save("shippingOperation", {
              ...operation,
              state: "done",
              result,
              updatedAt: now(),
            });
            await state.refresh(id);
            return result;
          } catch (error) {
            await state.save("shippingOperation", {
              ...operation,
              state: "uncertain",
              updatedAt: now(),
            });
            throw error;
          }
        }
        throw new Error("method_unavailable");
      });
    },
  };
}
