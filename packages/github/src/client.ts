import {
  parse,
  type ShippingSnapshot,
  ShippingSnapshotSchema,
  type ShippingThread,
} from "../../protocol/src/index.js";
import { type GitHubTransport, ghTransport } from "./transport.js";

// biome-ignore lint/suspicious/noExplicitAny: GitHub union responses are normalized and validated before leaving this transport boundary.
type Data = Record<string, any>;
export const githubRepository = (value: string) => {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) ||
    value.split("/").some((p) => p === "." || p === "..")
  )
    throw new Error("github_repository_invalid");
  return value;
};
export function pullUrl(raw: string) {
  const url = new URL(raw);
  const match = /^\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)\/?$/.exec(url.pathname);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !match
  )
    throw new Error("github_pr_url_invalid");
  return { repository: githubRepository(match[1] ?? ""), number: Number(match[2]) };
}
const safeUrl = (value: unknown) => {
  try {
    const url = new URL(String(value));
    return url.protocol === "https:" && !url.username && !url.password
      ? url.href.slice(0, 2048)
      : "";
  } catch {
    return "";
  }
};
export function remoteRepository(raw: string) {
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(
      raw,
    );
  if (!match) throw new Error("github_remote_unsupported");
  return githubRepository(match[1] ?? "");
}
export function githubClient(transport: GitHubTransport = ghTransport) {
  const api = async (endpoint: string, method = "GET", body?: unknown): Promise<Data> =>
    (await transport(endpoint, method, body)) as Data;
  const gql = async (query: string, variables: unknown) =>
    (await api("graphql", "POST", { query, variables })).data as Data;
  async function account() {
    const user = await api("/user");
    if (typeof user.login !== "string") throw new Error("github_auth_required");
    return user.login as string;
  }
  async function repository(name: string) {
    githubRepository(name);
    const row = await api(`/repos/${name}`);
    return {
      id: String(row.node_id),
      name: String(row.full_name),
      defaultBranch: String(row.default_branch),
      canPush: row.permissions?.push === true,
      methods: [
        row.allow_merge_commit && "MERGE",
        row.allow_squash_merge && "SQUASH",
        row.allow_rebase_merge && "REBASE",
      ].filter(Boolean) as ("MERGE" | "SQUASH" | "REBASE")[],
    };
  }
  async function pull(name: string, number: number): Promise<ShippingSnapshot> {
    githubRepository(name);
    const [owner, repoName] = name.split("/");
    const data = await gql(
      `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){id viewerPermission mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed pullRequest(number:$number){id number url title state isDraft headRefOid baseRefOid headRefName baseRefName headRepository{nameWithOwner} mergeable mergeStateStatus reviewDecision mergeQueueEntry{position} commits(last:1){nodes{commit{oid statusCheckRollup{contexts(first:100){pageInfo{hasNextPage} nodes{__typename ... on CheckRun{id databaseId name status conclusion detailsUrl checkSuite{commit{oid}}} ... on StatusContext{id context state targetUrl}}}}}}} reviews(first:50){pageInfo{hasNextPage} nodes{id author{login} body url state}} comments(first:50){pageInfo{hasNextPage} nodes{id author{login} body url}}}}}`,
      { owner, name: repoName, number },
    );
    const repo = data.repository,
      pr = repo?.pullRequest;
    if (!pr) throw new Error("github_pr_unavailable");
    let complete = !pr.reviews.pageInfo.hasNextPage && !pr.comments.pageInfo.hasNextPage;
    const threads: ShippingThread[] = [];
    let cursor: string | null = null;
    do {
      const page = await gql(
        `query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:50,after:$cursor){pageInfo{hasNextPage endCursor} nodes{id path line isResolved isOutdated comments(first:20){pageInfo{hasNextPage} nodes{author{login} body url diffHunk}}}}}}}`,
        { owner, name: repoName, number, cursor },
      );
      const connection = page.repository.pullRequest.reviewThreads;
      for (const thread of connection.nodes) {
        if (thread.comments.pageInfo.hasNextPage) complete = false;
        const comments = thread.comments.nodes as Data[];
        threads.push({
          id: thread.id,
          path: String(thread.path).slice(0, 2000),
          ...(Number.isInteger(thread.line) ? { line: thread.line } : {}),
          author: String(comments[0]?.author?.login ?? "Deleted user"),
          body: comments
            .map((c) => `${c.author?.login ?? "Deleted user"}: ${c.body}`)
            .join("\n\n")
            .slice(0, 16000),
          url: safeUrl(comments[0]?.url),
          diff: String(comments[0]?.diffHunk ?? "").slice(0, 12000),
          resolved: thread.isResolved,
          outdated: thread.isOutdated,
          kind: "thread",
        });
      }
      cursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
      if (threads.length >= 100 && cursor) {
        complete = false;
        break;
      }
    } while (cursor);
    for (const [kind, rows] of [
      ["review", pr.reviews.nodes],
      ["comment", pr.comments.nodes],
    ] as const) {
      for (const row of rows as Data[])
        if (row.body || row.state === "CHANGES_REQUESTED")
          threads.push({
            id: row.id,
            author: String(row.author?.login ?? "Deleted user"),
            path: "",
            body: `${row.state ?? ""}\n${row.body ?? ""}`.trim().slice(0, 16000),
            url: safeUrl(row.url),
            resolved: false,
            outdated: false,
            kind,
          });
    }
    const commit = pr.commits.nodes[0]?.commit;
    const contexts = commit?.statusCheckRollup?.contexts;
    if (contexts?.pageInfo.hasNextPage) complete = false;
    const checks = (contexts?.nodes ?? []).map((check: Data) => ({
      id: String(check.databaseId ?? check.id),
      name: String(check.name ?? check.context).slice(0, 2000),
      state: String(check.conclusion || check.status || check.state || "UNKNOWN"),
      sha: String(check.checkSuite?.commit?.oid ?? commit.oid),
      url: safeUrl(check.detailsUrl ?? check.targetUrl),
    }));
    const writable = ["WRITE", "MAINTAIN", "ADMIN"].includes(repo.viewerPermission);
    const result = parse(ShippingSnapshotSchema, {
      number: pr.number,
      nodeId: pr.id,
      repositoryId: repo.id,
      url: safeUrl(pr.url),
      title: String(pr.title).slice(0, 2000),
      state: pr.state,
      draft: pr.isDraft,
      head: pr.headRefOid,
      base: pr.baseRefOid,
      headBranch: pr.headRefName,
      baseBranch: pr.baseRefName,
      headRepository: pr.headRepository?.nameWithOwner ?? "",
      ...(pr.mergeQueueEntry ? { queuePosition: pr.mergeQueueEntry.position } : {}),
      mergeable: pr.mergeable,
      mergeState: pr.mergeStateStatus,
      reviewDecision: pr.reviewDecision ?? "UNKNOWN",
      canPush: writable,
      canMerge: writable,
      mergeMethods: [
        repo.mergeCommitAllowed && "MERGE",
        repo.squashMergeAllowed && "SQUASH",
        repo.rebaseMergeAllowed && "REBASE",
      ].filter(Boolean),
      checks,
      threads: threads.slice(0, 200),
      complete: complete && threads.length <= 200,
      requirementsKnown: false,
      fetchedAt: new Date().toISOString(),
    });
    // Keep cached records bounded for desktop events and the existing mobile relay frame limit.
    // Removed pages are explicitly marked partial; full discussion remains on GitHub.
    while (Buffer.byteLength(JSON.stringify(result), "utf8") > 64000) {
      result.complete = false;
      if (result.threads.length) result.threads.pop();
      else if (result.checks.length) result.checks.pop();
      else throw new Error("github_response_limit");
    }
    return result;
  }
  return {
    account,
    repository,
    async branch(name: string, branch: string) {
      try {
        const value = await api(
          `/repos/${githubRepository(name)}/branches/${encodeURIComponent(branch)}`,
        );
        if (!/^[a-f0-9]{40,64}$/.test(String(value.commit?.sha)))
          throw new Error("github_response_invalid");
        return String(value.commit.sha);
      } catch {
        throw new Error("github_base_unavailable");
      }
    },
    pull,
    async find(name: string, branch: string) {
      githubRepository(name);
      const [owner] = name.split("/");
      const rows = await api(
        `/repos/${name}/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=100`,
      );
      return (rows as unknown as Data[]).filter(
        (p) =>
          p.head?.ref === branch && p.head?.repo?.full_name?.toLowerCase() === name.toLowerCase(),
      );
    },
    async create(
      name: string,
      input: { title: string; body: string; branch: string; baseBranch: string; draft: boolean },
    ) {
      const row = await api(`/repos/${githubRepository(name)}/pulls`, "POST", {
        title: input.title,
        body: input.body,
        head: input.branch,
        base: input.baseBranch,
        draft: input.draft,
      });
      return Number(row.number);
    },
    async merge(name: string, number: number, sha: string, method: string) {
      const result = await api(`/repos/${githubRepository(name)}/pulls/${number}/merge`, "PUT", {
        sha,
        merge_method: method.toLowerCase(),
      });
      if (!result.merged) throw new Error("github_merge_not_completed");
      return { sha: String(result.sha) };
    },
    async diagnostics(name: string, checkId: string) {
      if (!/^[0-9]+$/.test(checkId)) return "Diagnostics are available at the external check link.";
      const endpoint = `/repos/${githubRepository(name)}`;
      const result = await api(`${endpoint}/check-runs/${checkId}/annotations?per_page=60`);
      let text = (result as unknown as Data[])
        .map((a) => `${a.path}:${a.start_line} ${a.title ?? ""}\n${a.message ?? ""}`)
        .join("\n\n")
        .slice(0, 6000);
      try {
        const check = await api(`${endpoint}/check-runs/${checkId}`);
        const url = new URL(String(check.details_url));
        const match = /^\/([^/]+\/[^/]+)\/actions\/runs\/([0-9]+)\/job\/([0-9]+)$/.exec(
          url.pathname,
        );
        if (
          check.app?.slug === "github-actions" &&
          url.hostname === "github.com" &&
          url.protocol === "https:" &&
          match?.[1]?.toLowerCase() === name.toLowerCase()
        ) {
          const job = await api(`${endpoint}/actions/jobs/${match[3]}`);
          const checkUrl = new URL(String(job.check_run_url));
          if (
            checkUrl.hostname !== "api.github.com" ||
            checkUrl.pathname.toLowerCase() !== `${endpoint}/check-runs/${checkId}`.toLowerCase() ||
            job.head_sha !== check.head_sha
          )
            throw new Error("github_job_identity_changed");
          const logs = await transport(`${endpoint}/actions/jobs/${match[3]}/logs`);
          if (typeof logs !== "string") throw new Error("github_logs_invalid");
          text += `\n\nGitHub Actions log excerpt (last 60 lines):\n${logs.split("\n").slice(-60).join("\n").slice(-6000)}`;
        }
      } catch {
        text +=
          "\n\nFull logs are unavailable or exceed the download limit. Open the check on GitHub.";
      }
      return (
        text
          // biome-ignore lint/suspicious/noControlCharactersInRegex: strip terminal control sequences from remote text.
          .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
          .slice(0, 12000)
          .trim() || "No annotations available. Open the check on GitHub for full logs."
      );
    },
  };
}
export type GitHubClient = ReturnType<typeof githubClient>;
