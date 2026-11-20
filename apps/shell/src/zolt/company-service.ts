import { randomUUID } from "node:crypto";
import type { CompanyOverview, DecidePlanInput } from "../shared/ipc";
import { type CompanyReadResult, toCompanyOverview } from "./company-view";
import type { DaemonClient } from "./daemon-client";

/** Reads one project's company: its people, pending plans, initiatives and latest brief. */
export async function readCompany(
  client: DaemonClient,
  projectId: string,
): Promise<CompanyOverview> {
  const read = (await client.call("company.read", { projectId })) as CompanyReadResult;
  return toCompanyOverview(projectId, read, client.snapshot);
}

/** The person's decision on a plan. The daemon refuses it if the plan or company changed. */
export async function decidePlan(
  client: DaemonClient,
  input: DecidePlanInput,
): Promise<CompanyOverview> {
  const read = (await client.call("company.read", {
    projectId: input.projectId,
  })) as CompanyReadResult;
  const plan = (read.plans ?? []).find((row) => row.id === input.planId);
  if (!plan || plan.state !== "proposed") throw new Error("This plan was already decided.");
  if (Number(plan.version) !== input.version)
    throw new Error("This plan changed. Review it again.");
  try {
    await client.call(
      "company.decide",
      {
        id: input.planId,
        version: input.version,
        baseline: plan.baseline,
        approve: input.approve,
      },
      `shell:decide:${input.planId}:${input.version}:${input.approve ? "approve" : "decline"}`,
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes("stale_plan"))
      throw new Error("The company changed since this plan was made. Ask for a new plan.");
    throw error;
  }
  return readCompany(client, input.projectId);
}

/** Writes a new project brief from the current work, then returns the updated company. */
export async function refreshBrief(
  client: DaemonClient,
  projectId: string,
): Promise<CompanyOverview> {
  await client.call("company.brief", { projectId }, randomUUID());
  return readCompany(client, projectId);
}
