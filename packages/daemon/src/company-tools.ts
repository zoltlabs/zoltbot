import { createHash } from "node:crypto";
import { workspaceAuthority } from "@zoltbot/core";
import type { ToolActor, ToolInvocation } from "@zoltbot/hostmcp";
import type { RuntimeContext } from "./api.js";
import { compactCompanyView, companyApi } from "./company-api.js";
import { workspaceTools } from "./workspace-tools.js";

export const companyToolDefinition = {
  name: "company_work",
  description:
    "Organize work. describe returns contracts; read, propose, assign, dispatch, cancel, submit, recover, review, brief. Stable key for writes.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: [
          "describe",
          "read",
          "propose",
          "assign",
          "dispatch",
          "cancel",
          "submit",
          "recover",
          "brief",
          "shape_read",
          "create",
          "update",
          "review",
        ],
      },
      key: { type: "string", maxLength: 100 },
      request: { type: "object" },
    },
    required: ["action"],
    additionalProperties: false,
  },
};

const sectionAliases: Record<string, string> = {
  project: "projects",
  priority: "priorities",
  team: "teams",
  manager: "managers",
  remit: "remits",
  initiative: "initiatives",
  task: "tasks",
  result: "results",
  plan: "plans",
  brief: "briefs",
  decision: "decisions",
};
const validSections = new Set([
  "projects",
  "priorities",
  "teams",
  "managers",
  "remits",
  "initiatives",
  "tasks",
  "results",
  "plans",
  "briefs",
  "decisions",
]);

function compactTaskReceipt(value: Record<string, unknown>) {
  const keys = [
    "id",
    "projectId",
    "initiativeId",
    "title",
    "state",
    "revision",
    "planned",
    "threadId",
    "accountableThreadId",
    "executorThreadId",
    "authorityPlanId",
    "holdReason",
    "reviewState",
    "budgetUsd",
    "replacedByTaskId",
    "excludedKnowledgeIds",
    "updatedAt",
  ] as const;
  return Object.fromEntries(keys.filter((k) => value[k] !== undefined).map((k) => [k, value[k]]));
}

export function companyTools(context: RuntimeContext) {
  const api = companyApi(context);
  const workspace = workspaceTools(context);
  const authorize = (actor: ToolActor) => {
    const state = context.store.snapshot();
    return (
      !!workspaceAuthority(state, actor) ||
      state.initiativeRecord?.some(
        (r) =>
          r.managerThreadId === actor.threadId &&
          !["completed", "cancelled"].includes(String(r.state)),
      ) === true ||
      state.task?.some(
        (r) =>
          (r.accountableThreadId === actor.threadId || r.threadId === actor.threadId) &&
          !["completed", "cancelled"].includes(String(r.state)),
      ) === true
    );
  };
  return {
    authorize,
    async call(call: ToolInvocation) {
      if (!authorize(call.actor)) throw Error("company_scope_required");
      const args = call.arguments as {
        action: string;
        key?: string;
        request?: Record<string, unknown>;
      };
      if (args.action === "describe")
        return {
          read: "request {projectId?, section?: projects|priorities|teams|managers|remits|initiatives|tasks|results|plans|briefs|decisions, id?, offset?, limit?}. Bounded results; queued/blocked tasks include launchReadiness.",
          propose:
            "request {id,projectId,title,explanation,changes:[...],authority?}. Saves proposal; human approves once in workspace.",
          assign:
            "request {value:<task>,planId?}. Stable key. Creates a new task (or dispatches matching planned task). Direct human work needs no manager or initiative; agent delegation requires applied authority.",
          dispatch:
            "request {taskId,planId?,brief?,acceptance?,profileId?,accountableThreadId?,budgetUsd?}. Stable key. Dispatches an existing planned task, preserving identity, dependencies and acceptance.",
          submit:
            "request {taskId,status:done|partial|blocked|failed,summary,files?:[string],planId?}. Stable key. Records a taskResult for direct manager/IC execution and moves done work to review.",
          cancel:
            "request {taskId,reason?,planId?,replacementTaskId?}. Stable key. Cancels non-completed task, interrupts active turn, and releases plan task/budget reservation.",
          recover:
            "request {taskId,planId?,excludeOptionalKnowledgeIds?:[id],brief?}. Stable key. Recovers held/blocked/failed task; required/constraint/initiative knowledge cannot be excluded.",
          review:
            "request {taskId,revision,decision:accept|changes|reject,feedback?,planId}. Stable key. Requires reviewTasks authority and an independent reviewer (never self-review).",
          brief:
            "request {projectId,summary?}. Stable key. Saves dated evidence-backed brief (deduplicating identical same-day retries) and returns a compact receipt.",
          shape:
            "shape_read lists workspace objects/profiles; create {kind:project|subproject|chat,name,parent?,goal?,profileId?,manager?}; update {target:{type,id},changes:{field:string}}.",
          changes: {
            team: "{kind:'team',id,name,parent:{type:'project'|'subproject',id},why}",
            chat: "{kind:'chat',id,title,parent,profileId,manager:boolean,why}",
            initiative:
              "{kind:'initiative',value:{id,projectId,teamId?,title,outcome,acceptance,managerThreadId?,priority:low|normal|high|urgent,state:proposed|active|paused|review|completed|cancelled,constraints,knowledgeIds:[],version,createdAt,updatedAt,targetDate?,budgetUsd?},why}",
            remit:
              "{kind:'remit',value:{id:chatId,threadId:chatId,projectId,responsibilities,capabilities,boundaries,escalation,version,updatedAt},why}",
            task: "{kind:'task',value:{id,title,brief,acceptance?,profileId,node:{type:'project'|'subproject',id},initiativeId?,accountableThreadId?,parentId?,dependencies?:[taskId],planned?:boolean,budgetUsd?},why}",
            reorg:
              "{kind:'assignManager',id:chatId,parent,why} | {kind:'moveTask',id,initiativeId?,accountableThreadId?,why} | {kind:'renameTeam',id,name,why} | {kind:'moveTeam'|'moveChat',id,parent,why} | {kind:'archiveTeam',id,why} | {kind:'assignTask',id,accountableThreadId,why} | {kind:'releaseTask',id,why}",
          },
          authority:
            "{initiativeId,maxTasks:1..100,reviewTasks?:boolean,permissionCeiling:read_only|workspace_write|workspace_write_net|full_access,budgetUsd}. Budget is a task reservation separate from provider billing.",
        };
      if (["shape_read", "create", "update"].includes(args.action)) {
        const tool = workspace.tools.get(
          args.action === "shape_read" ? "workspace_read" : `workspace_${args.action}`,
        );
        if (!tool) throw Error("workspace_tool_unavailable");
        return tool({
          ...call,
          arguments: { ...args.request, ...(args.key ? { key: args.key } : {}) },
        });
      }
      if (!args.key && args.action !== "read") throw Error("stable_key_required");
      const commandId = args.key
        ? `company-tool:${createHash("sha256")
            .update(JSON.stringify([call.actor.threadId, args.action, args.key]))
            .digest("hex")}`
        : undefined;
      if (args.action === "read") {
        const {
          section: rawSection,
          id,
          offset,
          limit,
          ...readReq
        } = (args.request ?? {}) as Record<string, unknown>;
        const section =
          typeof rawSection === "string" ? (sectionAliases[rawSection] ?? rawSection) : undefined;
        if (section && !validSections.has(section))
          throw Error(
            "invalid_section: choose projects, priorities, teams, managers, remits, initiatives, tasks, results, plans, briefs, or decisions",
          );
        if (!readReq.projectId) {
          const state = context.store.snapshot();
          const actorThread = state.thread?.find((t) => t.id === call.actor.threadId);
          if (actorThread?.projectId) readReq.projectId = String(actorThread.projectId);
          else if ((section && section !== "projects" && section !== "priorities") || id) {
            const top = (await api("company.read", {}, undefined, call.actor)) as {
              projects?: { id: string }[];
            };
            const accessible = new Set((top.projects ?? []).map((p) => String(p.id)));
            if (typeof id === "string") {
              for (const table of [
                state.initiativeRecord,
                state.task,
                state.companyPlan,
                state.projectBrief,
                state.subproject,
                state.managerRemit,
                state.thread,
              ]) {
                const match = table?.find(
                  (r) => r.id === id && accessible.has(String(r.projectId ?? "")),
                );
                if (match?.projectId) {
                  readReq.projectId = String(match.projectId);
                  break;
                }
              }
            }
            if (!readReq.projectId) {
              if (accessible.size === 1) readReq.projectId = [...accessible][0];
              else if (accessible.size > 1)
                throw Error(
                  "project_id_required: pass request.projectId (call read without section to list projects)",
                );
            }
          }
        }
        const rawResult = await api("company.read", readReq, undefined, call.actor);
        if (rawResult === undefined) throw Error("unknown_company_action");
        let view = compactCompanyView(rawResult);
        if (section) view = { [section]: view[section] ?? [] };
        for (const [k, v] of Object.entries(view))
          if (Array.isArray(v) && typeof id === "string")
            view[k] = v.filter((r) => (r as { id?: unknown }).id === id);
        const counts = Object.fromEntries(
          Object.entries(view)
            .filter(([, v]) => Array.isArray(v))
            .map(([k, v]) => [k, (v as unknown[]).length]),
        );
        const startOffset =
          typeof offset === "number" && Number.isFinite(offset) && offset > 0
            ? Math.floor(offset)
            : 0;
        const pageLimit =
          typeof limit === "number" && Number.isFinite(limit) && limit > 0
            ? Math.min(50, Math.floor(limit))
            : undefined;
        for (const [k, v] of Object.entries(view))
          if (Array.isArray(v))
            view[k] =
              pageLimit !== undefined
                ? v.slice(startOffset, startOffset + pageLimit)
                : v.slice(startOffset);
        const buildReadEnvelope = () => {
          const hasMore = Object.entries(view).some(
            ([k, v]) => Array.isArray(v) && startOffset + v.length < (counts[k] ?? 0),
          );
          return {
            ...(readReq.projectId ? { projectId: readReq.projectId } : {}),
            ...view,
            counts,
            ...(startOffset > 0 ? { offset: startOffset } : {}),
            ...(hasMore ? { hasMore: true } : {}),
            hint: "Select request section/id, offset and limit for omitted records.",
          };
        };
        const minimizedKeys = new Set<string>();
        while (JSON.stringify(buildReadEnvelope()).length > 3600) {
          const largest = Object.entries(view)
            .filter(
              ([k, v]) =>
                Array.isArray(v) && v.length > 0 && !(v.length === 1 && minimizedKeys.has(k)),
            )
            .sort((a, b) => JSON.stringify(b[1]).length - JSON.stringify(a[1]).length)[0];
          if (!largest) break;
          const [key, rawArr] = largest;
          const value = rawArr as Record<string, unknown>[];
          if (value.length > 1) {
            view[key] = value.slice(0, Math.floor(value.length / 2));
            continue;
          }
          const single = value[0] as Record<string, unknown>;
          if (Array.isArray(single.changes) && single.changes.length > 3) {
            view[key] = [
              {
                ...single,
                changeCount: single.changes.length,
                changes: single.changes.slice(0, 3),
              },
            ];
            if (JSON.stringify(buildReadEnvelope()).length <= 3600) break;
          }
          view[key] = JSON.parse(
            JSON.stringify(view[key], (_k, v) =>
              typeof v === "string" && v.length > 120 ? `${v.slice(0, 120)}…` : v,
            ),
          );
          if (JSON.stringify(buildReadEnvelope()).length > 3600) {
            view[key] = section
              ? [
                  {
                    ...(single.id !== undefined ? { id: single.id } : {}),
                    ...(single.state !== undefined ? { state: single.state } : {}),
                    truncated: true,
                  },
                ]
              : [];
          }
          minimizedKeys.add(key);
        }
        return buildReadEnvelope();
      }
      const normalizedRequest = { ...(args.request ?? {}) };
      if (
        args.action === "recover" &&
        normalizedRequest.excludeKnowledgeIds !== undefined &&
        normalizedRequest.excludeOptionalKnowledgeIds === undefined
      ) {
        normalizedRequest.excludeOptionalKnowledgeIds = normalizedRequest.excludeKnowledgeIds;
        delete normalizedRequest.excludeKnowledgeIds;
      }
      if (
        args.action === "cancel" &&
        normalizedRequest.replacedByTaskId !== undefined &&
        normalizedRequest.replacementTaskId === undefined
      ) {
        normalizedRequest.replacementTaskId = normalizedRequest.replacedByTaskId;
        delete normalizedRequest.replacedByTaskId;
      }
      const result = await api(`company.${args.action}`, normalizedRequest, commandId, call.actor);
      if (result === undefined) throw Error("unknown_company_action");
      if (args.action === "propose") {
        const plan = result as { id: string; version: number };
        return {
          id: plan.id,
          version: plan.version,
          status: "proposed",
          review:
            "Open the workspace Organization and work panel to inspect and approve. No changes have been applied.",
        };
      }
      if (args.action === "brief") {
        const brief = result as {
          id: string;
          projectId: string;
          day: string;
          revision: number;
          summary: string;
          deduplicated?: boolean;
          evidence?: {
            initiatives?: unknown[];
            tasks?: unknown[];
            results?: unknown[];
            decisions?: unknown[];
          };
          createdAt: string;
        };
        return {
          id: brief.id,
          projectId: brief.projectId,
          day: brief.day,
          revision: brief.revision,
          ...(brief.deduplicated ? { deduplicated: true } : {}),
          summary: brief.summary.length > 600 ? `${brief.summary.slice(0, 600)}…` : brief.summary,
          evidenceCounts: {
            initiatives: brief.evidence?.initiatives?.length ?? 0,
            tasks: brief.evidence?.tasks?.length ?? 0,
            results: brief.evidence?.results?.length ?? 0,
            decisions: brief.evidence?.decisions?.length ?? 0,
          },
          createdAt: brief.createdAt,
        };
      }
      if (args.action === "submit") {
        const submitted = result as {
          task?: Record<string, unknown>;
          taskResult?: Record<string, unknown>;
        };
        return {
          task: submitted.task ? compactTaskReceipt(submitted.task) : undefined,
          taskResult: submitted.taskResult
            ? {
                id: submitted.taskResult.id,
                taskId: submitted.taskResult.taskId,
                revision: submitted.taskResult.revision,
                status: submitted.taskResult.status,
                auto: submitted.taskResult.auto,
              }
            : undefined,
        };
      }
      if (["assign", "dispatch", "cancel", "recover", "review"].includes(args.action)) {
        return compactTaskReceipt(result as Record<string, unknown>);
      }
      return result;
    },
  };
}
