import type { Shipping } from "@zoltbot/protocol";

export const failureStates = new Set([
  "FAILURE",
  "FAILED",
  "ERROR",
  "TIMED_OUT",
  "ACTION_REQUIRED",
  "CANCELLED",
  "STARTUP_FAILURE",
  "STALE",
]);
export function attention(binding: Shipping) {
  const pr = binding.snapshot;
  return Boolean(
    pr?.state === "OPEN" &&
      (failureStates.has(pr.mergeState) ||
        ["DIRTY", "BLOCKED"].includes(pr.mergeState) ||
        pr.reviewDecision === "CHANGES_REQUESTED" ||
        pr.checks.some((c) => failureStates.has(c.state)) ||
        pr.threads.some((t) => t.kind === "thread" && !t.resolved)),
  );
}
export function summary(binding: Shipping) {
  const pr = binding.snapshot;
  if (!pr) return "Publishing in progress";
  const failed = pr.checks.filter((c) => failureStates.has(c.state)).length;
  const threads = pr.threads.filter((t) => t.kind === "thread" && !t.resolved).length;
  return [
    `PR #${pr.number}`,
    pr.state === "MERGED"
      ? "Merged"
      : pr.state === "CLOSED"
        ? "Closed"
        : pr.draft
          ? "Draft"
          : "Open",
    failed ? `${failed} check${failed === 1 ? "" : "s"} failing` : "",
    threads ? `${threads} unresolved thread${threads === 1 ? "" : "s"}` : "",
    binding.error ? "Update unavailable" : "",
  ]
    .filter(Boolean)
    .join(" · ");
}
export function shippingError(error: unknown) {
  const code = error instanceof Error ? error.message.split(":")[0] : "";
  const messages: Record<string, string> = {
    github_cli_unavailable: "Install GitHub CLI on this Mac, then sign in with gh auth login.",
    github_auth_required: "Sign in with gh auth login on this Mac, then retry.",
    github_account_changed:
      "The active GitHub account changed. Switch back to the account used for this PR.",
    github_write_refused:
      "GitHub refused the action. Check repository rules, required reviews, branch state, and merge-queue requirements on GitHub.",
    github_base_unavailable:
      "The selected base branch is missing or inaccessible. Choose an existing branch before publishing.",
    shipping_target_update_required:
      "Update this task from the selected GitHub base branch in its worktree, then create a new review commit. Nothing has been pushed.",
    github_access_denied:
      "GitHub did not grant access. Check repository permissions and organization authorization.",
    github_rate_limited:
      "GitHub rate limited this request. Automatic refresh will back off; try again later.",
    github_request_failed:
      "GitHub could not be reached. Your local work is preserved. Retry when connected.",
    shipping_worktree_required: "Publishing requires a task with a separate Git worktree.",
    shipping_review_commit_required:
      "Create a review commit for this task revision before publishing.",
    shipping_review_required:
      "Wait for the task to finish and review its changes before publishing.",
    shipping_preview_expired: "This preview expired. Review a fresh preview before continuing.",
    shipping_preview_stale: "The task, code, or GitHub state changed. Review a fresh preview.",
    shipping_remote_changed:
      "The GitHub branch changed or diverged. Reconcile it in the task worktree, then review again. Zoltbot will not force-push.",
    shipping_branch_exists:
      "That branch already exists. Choose a different branch name or link its PR.",
    shipping_repository_mismatch:
      "This PR does not belong to a supported GitHub remote of this task.",
    github_remote_unsupported:
      "Choose a standard GitHub.com HTTPS or SSH remote. Fork publishing and enterprise hosts are not supported yet.",
    shipping_binding_changed:
      "The repository, account, or branch no longer matches this task's publishing setup.",
    shipping_feedback_too_large_select_fewer:
      "This feedback exceeds the message budget. Select fewer items or shorten your note; nothing has been omitted or sent.",
    shipping_feedback_source_changed:
      "Selected feedback changed on GitHub. Review it again before sending.",
    shipping_execution_approval_required:
      "Approve the exact Git execution request in Needs you, then continue here.",
    shipping_creation_uncertain:
      "The branch was published, but PR creation is uncertain. Check GitHub before taking another action. Retrying will first look for the existing PR.",
    shipping_merge_uncertain_check_github:
      "The merge result is uncertain. Check GitHub; retry checks the remote result without submitting another merge.",
    shipping_merge_unavailable:
      "GitHub has not reported this accepted PR as clean and mergeable. Check draft status, reviews, checks, and repository rules on GitHub.",
    shipping_unpublished_changes: "Review and push the latest changes before merging.",
    shipping_url_rewrite_unsupported:
      "Git URL rewrites are configured. Use a repository without URL rewriting for managed GitHub publishing.",
    shipping_branch_invalid:
      "Choose a valid feature branch name; main, master and HEAD are not publishing branches.",
    shipping_base_invalid: "Choose a valid base branch different from the publishing branch.",
  };
  return (
    messages[code ?? ""] ??
    "This action could not finish. Your work is preserved. Refresh the state and try again, or inspect the PR on GitHub."
  );
}
export function safeLink(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password
      ? parsed.href
      : undefined;
  } catch {
    return undefined;
  }
}
