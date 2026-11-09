import { expect, test } from "vitest";
import { githubClient, githubRepository, pullUrl, remoteRepository } from "./client.js";

test("only supported repository and PR identities are accepted", () => {
  expect(remoteRepository("git@github.com:owner/repo.git")).toBe("owner/repo");
  expect(remoteRepository("https://github.com/owner/repo.git")).toBe("owner/repo");
  expect(pullUrl("https://github.com/owner/repo/pull/123")).toEqual({
    repository: "owner/repo",
    number: 123,
  });
  for (const raw of [
    "https://github.com.evil.test/owner/repo/pull/1",
    "https://user@github.com/owner/repo/pull/1",
    "https://github.com/owner/repo/pull/1?token=x",
    "http://github.com/owner/repo/pull/1",
  ])
    expect(() => pullUrl(raw)).toThrow();
  expect(() => remoteRepository("https://token@github.com/owner/repo.git")).toThrow();
  expect(() => githubRepository("../repo")).toThrow();
});
test("GitHub normalization preserves differing check SHAs, review states and partial-data metadata", async () => {
  const head = "a".repeat(40),
    merge = "b".repeat(40);
  let pages = 0;
  const client = githubClient(async (_endpoint, _method, body) => {
    const query = (body as { query: string }).query;
    if (query.includes("reviewThreads")) {
      pages++;
      return {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: pages === 1, endCursor: "page2" },
                nodes: [
                  {
                    id: `thread${pages}`,
                    path: "file",
                    line: 4,
                    isResolved: pages === 2,
                    isOutdated: true,
                    comments: {
                      pageInfo: { hasNextPage: pages === 1 },
                      nodes: [
                        { body: "Review", author: { login: "person" }, url: "javascript:alert(1)" },
                      ],
                    },
                  },
                ],
              },
            },
          },
        },
      };
    }
    return {
      data: {
        repository: {
          id: "repo",
          viewerPermission: "WRITE",
          mergeCommitAllowed: true,
          squashMergeAllowed: true,
          rebaseMergeAllowed: false,
          pullRequest: {
            id: "pr",
            number: 1,
            url: "https://github.com/o/r/pull/1",
            title: "PR",
            state: "OPEN",
            isDraft: false,
            headRefOid: head,
            baseRefOid: merge,
            headRefName: "feature",
            baseRefName: "main",
            headRepository: { nameWithOwner: "o/r" },
            mergeable: "UNKNOWN",
            mergeStateStatus: "UNKNOWN",
            reviewDecision: null,
            commits: {
              nodes: [
                {
                  commit: {
                    oid: head,
                    statusCheckRollup: {
                      contexts: {
                        pageInfo: { hasNextPage: false },
                        nodes: [
                          {
                            databaseId: 1,
                            name: "test",
                            status: "COMPLETED",
                            conclusion: "FAILURE",
                            detailsUrl: "https://example.test/check",
                            checkSuite: { commit: { oid: merge } },
                          },
                        ],
                      },
                    },
                  },
                },
              ],
            },
            reviews: { pageInfo: { hasNextPage: false }, nodes: [] },
            comments: { pageInfo: { hasNextPage: false }, nodes: [] },
          },
        },
      },
    };
  });
  const result = await client.pull("o/r", 1);
  expect(pages).toBe(2);
  expect(result.complete).toBe(false);
  expect(result.requirementsKnown).toBe(false);
  expect(result.mergeable).toBe("UNKNOWN");
  expect(result.checks[0]?.sha).toBe(merge);
  expect(result.threads[0]?.outdated).toBe(true);
  expect(result.threads[1]?.resolved).toBe(true);
  expect(result.threads[0]?.url).toBe("");
});
test("merge request supplies the exact expected head and allowed method", async () => {
  const requests: unknown[] = [];
  const client = githubClient(async (...args) => {
    requests.push(args);
    return { merged: true, sha: "a".repeat(40) };
  });
  await client.merge("o/r", 4, "b".repeat(40), "SQUASH");
  expect(requests).toEqual([
    ["/repos/o/r/pulls/4/merge", "PUT", { sha: "b".repeat(40), merge_method: "squash" }],
  ]);
});

test("Actions diagnostics follow returned job identity and bound log excerpts, never guess job IDs", async () => {
  const endpoints: string[] = [];
  const client = githubClient(async (endpoint) => {
    endpoints.push(endpoint);
    if (endpoint.endsWith("annotations?per_page=60"))
      return [{ path: "file.ts", start_line: 3, message: "Failed assertion" }];
    if (endpoint.endsWith("check-runs/12"))
      return {
        app: { slug: "github-actions" },
        head_sha: "a".repeat(40),
        details_url: "https://github.com/o/r/actions/runs/90/job/42",
      };
    if (endpoint.endsWith("actions/jobs/42"))
      return {
        check_run_url: "https://api.github.com/repos/o/r/check-runs/12",
        head_sha: "a".repeat(40),
      };
    if (endpoint.endsWith("actions/jobs/42/logs"))
      return Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    throw new Error("unexpected_endpoint");
  });
  const text = await client.diagnostics("o/r", "12");
  expect(text).toContain("Failed assertion");
  expect(text).toContain("line 99");
  expect(text).not.toContain("line 0");
  expect(endpoints).toContain("/repos/o/r/actions/jobs/42/logs");
  expect(endpoints).not.toContain("/repos/o/r/actions/jobs/12/logs");
});
