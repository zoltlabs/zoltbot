import { nextRoutineRun } from "@zoltbot/protocol";
import { describe, expect, it } from "vitest";
import {
  matchStarterJobs,
  STARTER_JOBS,
  type StarterConnection,
  starterRoutineId,
} from "./starter-jobs.js";

const app = (id: string, service: string, projectId = "p", rest: Partial<StarterConnection> = {}) =>
  ({
    id,
    projectId,
    source: `catalog:${service}:v1`,
    enabled: true,
    credentialStatus: "connected",
    ...rest,
  }) satisfies StarterConnection;
const ids = (matches: ReturnType<typeof matchStarterJobs>) => matches.map((row) => row.job.id);

describe("starter jobs (D5)", () => {
  it("every schedule is one the routine scheduler accepts", () => {
    for (const job of STARTER_JOBS)
      expect(() =>
        nextRoutineRun({ cron: job.cron, timezone: "Europe/Berlin" }, "2026-11-21T10:00:00Z"),
      ).not.toThrow();
  });

  it("offers nothing when no app is connected", () => {
    expect(matchStarterJobs([], new Set(["p"]))).toEqual([]);
  });

  it("matches each job to a project where its app is signed in", () => {
    const matches = matchStarterJobs(
      [
        app("c-mail", "gmail", "home"),
        app("c-gh", "github", "code"),
        app("c-cal", "google_calendar", "home"),
      ],
      new Set(["home", "code"]),
    );
    expect(ids(matches)).toEqual(["weekly-inbox", "pull-request-review", "morning-briefing"]);
    expect(matches[1]).toMatchObject({ projectId: "code", connectionIds: ["c-gh"] });
    expect(matches[0]).toMatchObject({ projectId: "home", connectionIds: ["c-mail"] });
  });

  it("skips apps that aren't signed in, are off, belong to an archived project or aren't from the catalog", () => {
    expect(
      matchStarterJobs(
        [
          app("a", "gmail", "p", { credentialStatus: "needs_sign_in" }),
          app("b", "github", "p", { enabled: false }),
          app("c", "google_calendar", "gone"),
          { ...app("d", "gmail"), source: "manual" },
        ],
        new Set(["p"]),
      ),
    ).toEqual([]);
  });

  it("leaves out a job that was already added", () => {
    expect(
      ids(
        matchStarterJobs(
          [app("a", "gmail"), app("b", "github")],
          new Set(["p"]),
          new Set([starterRoutineId("weekly-inbox")]),
        ),
      ),
    ).toEqual(["pull-request-review"]);
  });
});
