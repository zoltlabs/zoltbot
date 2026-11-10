import { createHash } from "node:crypto";
import {
  assignCompanyTask,
  companyAccess,
  companyView,
  decideCompanyPlan,
  type Outcome,
  proposeCompanyPlan,
  reviewCompanyTask,
  scopeContains,
  type TaskInput,
  type WorkspaceActor,
  workspaceAuthority,
  writeProjectBrief,
} from "@zoltbot/core";
import { type CompanyPlan, companyMethods, parse } from "@zoltbot/protocol";
import type { RuntimeContext } from "./api.js";

export function companyApi(context: RuntimeContext) {
  return async (
    method: string,
    params: Record<string, unknown>,
    commandId?: string,
    actor?: WorkspaceActor,
  ) => {
    if (!(method in companyMethods)) return undefined;
    const contract = companyMethods[method as keyof typeof companyMethods];
    parse(contract.params, params);
    const state = context.store.snapshot();
    if (actor) {
      const projectId = String(
        params.projectId ??
          (params.value as { node?: { id: string; type: string } } | undefined)?.node?.id ??
          "",
      );
      if (method === "company.read" && !params.projectId) {
        const projects = companyView(state).projects.filter((r) => {
          try {
            companyAccess(state, actor, String(r.id));
            return true;
          } catch {
            return false;
          }
        });
        return { projects: projects.map((r) => ({ id: r.id, name: r.name, goal: r.goal })) };
      }
      if (method === "company.decide") throw Error("human_approval_required");
      if (method !== "company.assign" && method !== "company.review")
        companyAccess(state, actor, projectId);
    }
    if (method === "company.read") {
      const view = companyView(state, params.projectId as string | undefined);
      if (!actor) return view;
      const authority = workspaceAuthority(state, actor);
      if (
        authority?.all ||
        authority?.scopes.some((r) => r.type === "project" && r.id === params.projectId)
      )
        return view;
      const owns = new Set(
        view.initiatives.filter((i) => i.managerThreadId === actor.threadId).map((i) => i.id),
      );
      const visible = (node: unknown) =>
        authority?.scopes.some((scope) => scopeContains(state, scope, node)) ?? false;
      return {
        ...view,
        teams: view.teams.filter((r) => visible({ type: "subproject", id: r.id })),
        managers: view.managers.filter((r) => visible(r.node)),
        remits: view.remits.filter(
          (r) =>
            visible(state.thread?.find((t) => t.id === r.threadId)?.node) ||
            r.threadId === actor.threadId,
        ),
        initiatives: view.initiatives.filter(
          (r) =>
            owns.has(r.id) ||
            visible(
              r.teamId
                ? { type: "subproject", id: r.teamId }
                : { type: "project", id: r.projectId },
            ),
        ),
        tasks: view.tasks.filter((r) => owns.has(String(r.initiativeId)) || visible(r.node)),
        plans: view.plans.filter(
          (r) =>
            r.requestedBy === actor.threadId ||
            owns.has(String((r.authority as { initiativeId?: string })?.initiativeId)),
        ),
        briefs: [],
        decisions: view.decisions.filter((r) =>
          visible(state.thread?.find((t) => t.id === r.threadId)?.node),
        ),
      };
    }
    if (!commandId) throw Error("command_id_required");
    const digest = createHash("sha256")
      .update(JSON.stringify({ method, params, actor }))
      .digest("hex");
    const old = context.store.receipt(commandId);
    if (old) {
      if ((old.result as { requestDigest?: string } | undefined)?.requestDigest !== digest)
        throw Error("command_receipt_conflict");
      const { requestDigest: _digest, ...value } = old.result as Record<string, unknown>;
      return value;
    }
    const check = await context.privacy.prepareData(params);
    const before = context.store.lastSeq();
    const result = context.store.dispatch(commandId, (current) => {
      check(current);
      const ctx = {
        commandId,
        at: new Date().toISOString(),
        actor: actor
          ? { kind: "agent" as const, id: actor.agentId }
          : { kind: "human" as const, id: "local-owner" },
      };
      let outcome: Outcome;
      if (method === "company.propose") {
        outcome = proposeCompanyPlan(
          current,
          actor,
          params as Parameters<typeof proposeCompanyPlan>[2],
          ctx,
        );
      } else if (method === "company.decide")
        outcome = decideCompanyPlan(
          current,
          params as Parameters<typeof decideCompanyPlan>[1],
          ctx,
        );
      else if (method === "company.review")
        outcome = reviewCompanyTask(
          current,
          actor,
          params as Parameters<typeof reviewCompanyTask>[2],
          ctx,
        );
      else if (method === "company.assign")
        outcome = assignCompanyTask(
          current,
          actor,
          params.value as TaskInput,
          params.planId as string | undefined,
          ctx,
        );
      else
        outcome = writeProjectBrief(
          current,
          String(params.projectId),
          String(params.summary ?? ""),
          ctx,
        );
      return { ...outcome, result: { ...outcome.result, requestDigest: digest } };
    });
    context.publish(context.store.eventsSince(before));
    const { requestDigest: _digest, ...value } = result.result as Record<string, unknown>;
    return value;
  };
}
export function compactCompanyView(value: unknown) {
  const view = structuredClone(value) as Record<string, unknown>;
  for (const key of ["tasks", "initiatives", "managers", "remits", "decisions", "teams"]) {
    if (Array.isArray(view[key])) view[key] = (view[key] as unknown[]).slice(0, 40);
  }
  if (Array.isArray(view.plans))
    view.plans = (view.plans as CompanyPlan[])
      .slice(-10)
      .map(({ baseline: _baseline, preview: _preview, ...r }) => r);
  if (Array.isArray(view.briefs))
    view.briefs = (view.briefs as Record<string, unknown>[])
      .slice(-3)
      .map(({ evidence: _evidence, ...r }) => r);
  return view;
}
