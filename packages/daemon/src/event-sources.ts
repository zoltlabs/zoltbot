import { createHash } from "node:crypto";
import {
  parse,
  type Routine,
  type RoutineSourceEvent,
  RoutineSourceEventSchema,
} from "@zoltbot/protocol";
import type { GitHubTransport } from "../../github/src/transport.js";

export const eventHash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function eventRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("github_response_invalid");
  return value as Record<string, unknown>;
}
export interface EventIdentity {
  accountId: string;
  accountLabel: string;
  repositoryId: string;
  sourceMode: "local_poll" | "mock";
}
export interface EventScan {
  events: RoutineSourceEvent[];
  cursor: string;
  gap: boolean;
  quarantined: { key: string; digest: string; reason: string }[];
}
export interface EventSourceAdapter {
  supports(kind: string): boolean;
  verify(source: NonNullable<Routine["event"]>["source"]): Promise<EventIdentity>;
  scan(routine: Routine, now: string): Promise<EventScan>;
  validate(routine: Routine, event: RoutineSourceEvent): Promise<void>;
}
const record = eventRecord;
export function githubEventSource(transport: GitHubTransport): EventSourceAdapter {
  async function verify(source: NonNullable<Routine["event"]>["source"]): Promise<EventIdentity> {
    const account = record(await transport("/user"));
    const repository = record(await transport(`/repos/${source.resource}`));
    if (
      !Number.isSafeInteger(account.id) ||
      !Number.isSafeInteger(repository.id) ||
      String(repository.full_name).toLowerCase() !== source.resource.toLowerCase()
    )
      throw new Error("github_identity_unverified");
    if (source.reviewTeamId) {
      const teams = await transport("/user/teams?per_page=100");
      if (
        !Array.isArray(teams) ||
        !teams.some((team) => String(record(team).id) === source.reviewTeamId)
      )
        throw new Error("github_review_team_membership_required");
    }
    return {
      accountId: String(account.id),
      accountLabel: String(account.login ?? account.id).slice(0, 200),
      repositoryId: String(repository.id),
      sourceMode: "local_poll",
    };
  }
  async function boundIdentity(routine: Routine) {
    if (!routine.event) throw new Error("event_routine_required");
    const identity = await verify(routine.event.source);
    if (
      identity.accountId !== routine.event.accountId ||
      identity.repositoryId !== routine.event.repositoryId ||
      routine.event.sourceMode === "mock"
    )
      throw new Error("github_identity_changed_pause_and_review");
    return identity;
  }
  async function reviewerPresent(pr: Record<string, unknown>, routine: Routine) {
    const config = routine.event!;
    const requested = config.source.reviewTeamId ? pr.requested_teams : pr.requested_reviewers;
    const id = config.source.reviewTeamId ?? config.accountId;
    return Array.isArray(requested) && requested.some((value) => String(record(value).id) === id);
  }
  return {
    supports: (kind) => kind === "github.ci_failed" || kind === "github.review_requested",
    verify,
    async validate(routine, event) {
      await boundIdentity(routine);
      if (event.kind === "github.review_requested") {
        const pr = record(await transport(`/repos/${event.resource}/pulls/${event.subjectId}`));
        if (
          pr.state !== "open" ||
          record(pr.head).sha !== event.sha ||
          record(pr.base).sha !== event.baseSha ||
          !(await reviewerPresent(pr, routine))
        )
          throw new Error("github_review_superseded");
      } else {
        const branch = record(
          await transport(
            `/repos/${event.resource}/branches/${encodeURIComponent(event.branch ?? "")}`,
          ),
        );
        const current = record(
          await transport(`/repos/${event.resource}/actions/runs/${event.runId}`),
        );
        if (
          record(branch.commit).sha !== event.sha ||
          current.conclusion !== "failure" ||
          current.status !== "completed" ||
          current.head_sha !== event.sha ||
          current.run_attempt !== event.attempt
        )
          throw new Error("github_run_superseded");
      }
      if (String(record(await transport("/user")).id) !== event.accountId)
        throw new Error("github_identity_changed_pause_and_review");
    },
    async scan(routine, now) {
      const config = routine.event!;
      const identity = await boundIdentity(routine);
      const base = {
        normalizerVersion: 1,
        kind: config.source.kind,
        resource: config.source.resource,
        accountId: identity.accountId,
        resourceId: identity.repositoryId,
        receivedAt: now,
      };
      const result: EventScan = { events: [], cursor: now, gap: false, quarantined: [] };
      const quarantine = (value: unknown) =>
        result.quarantined.push({
          key: eventHash(value).slice(0, 24),
          digest: eventHash(value),
          reason: "Provider data could not be normalized; inspect source and retry",
        });
      if (config.source.kind === "github.review_requested") {
        const pulls = await transport(
          `/repos/${config.source.resource}/pulls?state=open&sort=updated&direction=desc&per_page=20`,
        );
        if (!Array.isArray(pulls)) throw new Error("github_response_invalid");
        result.gap = pulls.length >= 20;
        for (const value of pulls.slice(0, 20)) {
          try {
            const candidate = record(value);
            if (!Number.isSafeInteger(candidate.number)) {
              quarantine(value);
              continue;
            }
            const pr = record(
              await transport(`/repos/${config.source.resource}/pulls/${candidate.number}`),
            );
            if (pr.state !== "open" || !(await reviewerPresent(pr, routine))) continue;
            const timeline = await transport(
              `/repos/${config.source.resource}/issues/${candidate.number}/timeline?per_page=100`,
            );
            if (!Array.isArray(timeline)) throw new Error("github_response_invalid");
            result.gap ||= timeline.length >= 100;
            for (const item of timeline.slice(-100).reverse()) {
              const event = record(item);
              if (event.event !== "review_requested") continue;
              const target = config.source.reviewTeamId
                ? event.requested_team
                : event.requested_reviewer;
              if (
                !target ||
                String(record(target).id) !== (config.source.reviewTeamId ?? identity.accountId)
              )
                continue;
              if (Date.parse(String(event.created_at)) < Date.parse(config.enabledAt ?? now))
                continue;
              if (!Number.isSafeInteger(event.id)) throw new Error("github_response_invalid");
              const head = record(pr.head),
                baseRef = record(pr.base);
              if (
                ![head.sha, baseRef.sha].every(
                  (value) => typeof value === "string" && /^[a-f0-9]{40}$/.test(value),
                )
              )
                throw new Error("github_response_invalid");
              result.events.push(
                parse(RoutineSourceEventSchema, {
                  ...base,
                  digest: eventHash(event),
                  key: `gh-review-${identity.repositoryId}-${event.id}`,
                  occurredAt: event.created_at,
                  subjectId: String(candidate.number),
                  sha: head.sha,
                  baseSha: baseRef.sha,
                  branch: head.ref,
                  ...(config.source.reviewTeamId
                    ? { reviewTeamId: config.source.reviewTeamId }
                    : { reviewerId: identity.accountId }),
                  diagnostics: `Review requested for PR #${candidate.number}. Title (untrusted): ${String(pr.title).slice(0, 300)}. Return draft findings; do not post a review.`,
                }),
              );
              break;
            }
          } catch (error) {
            if (
              error instanceof Error &&
              error.message.startsWith("github_") &&
              error.message !== "github_response_invalid"
            )
              throw error;
            quarantine(value);
          }
        }
      } else {
        const page = record(
          await transport(
            `/repos/${config.source.resource}/actions/runs?status=failure&per_page=100`,
          ),
        );
        if (!Array.isArray(page.workflow_runs)) throw new Error("github_response_invalid");
        result.gap = Number(page.total_count) > 20;
        for (const value of page.workflow_runs.slice(0, 20).reverse()) {
          try {
            const candidate = record(value);
            if (!Number.isSafeInteger(candidate.id)) {
              quarantine(value);
              continue;
            }
            if (Date.parse(String(candidate.updated_at)) < Date.parse(config.enabledAt ?? now))
              continue;
            const current = record(
              await transport(`/repos/${config.source.resource}/actions/runs/${candidate.id}`),
            );
            if (
              current.id !== candidate.id ||
              current.conclusion !== "failure" ||
              current.status !== "completed" ||
              current.run_attempt !== candidate.run_attempt ||
              current.head_sha !== candidate.head_sha
            )
              continue;
            const branch = record(
              await transport(
                `/repos/${config.source.resource}/branches/${encodeURIComponent(String(current.head_branch))}`,
              ),
            );
            const jobs = record(
              await transport(
                `/repos/${config.source.resource}/actions/runs/${current.id}/attempts/${current.run_attempt}/jobs?per_page=20`,
              ),
            );
            if (!Array.isArray(jobs.jobs)) throw new Error("github_response_invalid");
            const diagnostics = JSON.stringify(
              jobs.jobs.slice(0, 20).map((value) => {
                const job = record(value);
                return {
                  name: String(job.name).slice(0, 100),
                  conclusion: String(job.conclusion).slice(0, 30),
                  failedSteps: Array.isArray(job.steps)
                    ? job.steps
                        .map(record)
                        .filter((step) => step.conclusion === "failure")
                        .slice(0, 5)
                        .map((step) => String(step.name).slice(0, 100))
                    : [],
                };
              }),
            ).slice(0, 1000);
            result.events.push(
              parse(RoutineSourceEventSchema, {
                ...base,
                digest: eventHash(current),
                superseded: record(branch.commit).sha !== current.head_sha,
                diagnostics,
                key: `gh-${identity.repositoryId}-${current.id}-${current.run_attempt}`,
                occurredAt: current.updated_at,
                sha: current.head_sha,
                branch: current.head_branch,
                workflowId: String(current.workflow_id),
                runId: String(current.id),
                attempt: current.run_attempt,
              }),
            );
          } catch (error) {
            if (
              error instanceof Error &&
              error.message.startsWith("github_") &&
              error.message !== "github_response_invalid"
            )
              throw error;
            quarantine(value);
          }
        }
      }
      if (String(record(await transport("/user")).id) !== identity.accountId)
        throw new Error("github_identity_changed_pause_and_review");
      return result;
    },
  };
}
