import type { Routine } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { githubEventSource } from "./event-sources.js";

function fixture(team = false) {
  let account = 42,
    requested = true,
    head = "a".repeat(40),
    base = "b".repeat(40);
  let malformed = false;
  const source = {
    kind: "github.review_requested" as const,
    resource: "example/app",
    ...(team ? { reviewTeamId: "5" } : {}),
  };
  const routine = {
    event: {
      source,
      accountId: "42",
      repositoryId: "7",
      sourceMode: "local_poll",
      enabledAt: "2026-11-06T12:00:00.000Z",
    },
  } as Routine;
  const adapter = githubEventSource(async (endpoint) => {
    if (endpoint === "/user") return { id: account };
    if (endpoint === "/user/teams?per_page=100") return [{ id: 5 }];
    if (endpoint === "/repos/example/app") return { id: 7, full_name: "example/app" };
    if (endpoint.includes("?state=open")) return [{ number: 10 }];
    if (endpoint.includes("/timeline"))
      return [
        {
          id: 1,
          event: "review_requested",
          requested_reviewer: { id: 42 },
          requested_team: { id: 5 },
          created_at: "2026-11-06T12:00:10.000Z",
        },
        {
          id: 2,
          event: "review_requested",
          requested_reviewer: { id: 99 },
          requested_team: { id: 99 },
          created_at: "2026-11-06T12:00:20.000Z",
        },
        {
          id: malformed ? undefined : 3,
          event: "review_requested",
          requested_reviewer: { id: 42 },
          requested_team: { id: 5 },
          created_at: "2026-11-06T12:00:30.000Z",
        },
      ];
    if (endpoint.endsWith("/pulls/10"))
      return {
        state: "open",
        head: { sha: head, ref: "feature" },
        base: { sha: base },
        requested_reviewers: requested ? [{ id: 42 }] : [],
        requested_teams: requested ? [{ id: 5 }] : [],
        title: "Untrusted PR",
      };
    throw new Error("unexpected_endpoint");
  });
  return {
    adapter,
    routine,
    removeRequest: () => {
      requested = false;
    },
    changeHead: () => {
      head = "c".repeat(40);
    },
    changeBase: () => {
      base = "d".repeat(40);
    },
    switchAccount: () => {
      account = 99;
    },
    malform: () => {
      malformed = true;
    },
  };
}
it.each([
  false,
  true,
])("hydrates only latest pending review request for the selected user/team (%s)", async (team) => {
  const f = fixture(team);
  const scan = await f.adapter.scan(f.routine, "2026-11-06T12:01:00.000Z");
  expect(scan.events).toHaveLength(1);
  expect(scan.events[0]).toMatchObject({
    key: "gh-review-7-3",
    sha: "a".repeat(40),
    baseSha: "b".repeat(40),
    subjectId: "10",
  });
  await expect(f.adapter.validate(f.routine, scan.events[0]!)).resolves.toBeUndefined();
  f.removeRequest();
  await expect(f.adapter.validate(f.routine, scan.events[0]!)).rejects.toThrow("superseded");
  expect((await f.adapter.scan(f.routine, "2026-11-06T12:02:00.000Z")).events).toHaveLength(0);
});
it("rejects head/base or identity drift and quarantines malformed request identity", async () => {
  for (const change of ["changeHead", "changeBase", "switchAccount"] as const) {
    const f = fixture();
    const scan = await f.adapter.scan(f.routine, "2026-11-06T12:01:00.000Z");
    f[change]();
    await expect(f.adapter.validate(f.routine, scan.events[0]!)).rejects.toThrow();
  }
  const f = fixture();
  f.malform();
  const scan = await f.adapter.scan(f.routine, "2026-11-06T12:01:00.000Z");
  expect(scan.events).toHaveLength(0);
  expect(scan.quarantined).toHaveLength(1);
});
