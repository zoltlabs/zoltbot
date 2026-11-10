import { createHash } from "node:crypto";
import { workspaceAuthority } from "@zoltbot/core";
import type { ToolActor, ToolInvocation } from "@zoltbot/hostmcp";
import type { RuntimeContext } from "./api.js";
import { compactCompanyView, companyApi } from "./company-api.js";
import { workspaceTools } from "./workspace-tools.js";

export const companyToolDefinition = {
  name: "company_work",
  description:
    "Organize work: describe contracts, read state, propose plans for human review, assign within approved authority, save brief. Stable key for writes. Direct chats need no setup.",
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
export function companyTools(context: RuntimeContext) {
  const api = companyApi(context);
  const workspace = workspaceTools(context);
  const authorize = (actor: ToolActor) => {
    const state = context.store.snapshot();
    return (
      !!workspaceAuthority(state, actor) ||
      state.initiativeRecord?.some(
        (r) => r.managerThreadId === actor.threadId && r.state === "active",
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
          workspace:
            "shape_read lists existing objects/profiles. create request {kind:project|subproject|chat,name,parent?:{type:project|subproject,id},goal?,profileId?,manager?}; update request {target:{type:project|subproject|chat|profile,id},changes:{field:string}}. Stable key. Uses existing workspace approvals.",
          read: "request {projectId?, section?: projects|teams|managers|remits|initiatives|tasks|plans|briefs|decisions, id?, offset?}. Bounded results; select a section/id for details.",
          propose:
            "request {id,projectId,title,explanation,changes:[...],authority?}. Saves a proposal; human approves in workspace. Read current state first. Use fresh ids; reference earlier creations in later changes.",
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
            "{initiativeId,maxTasks:1..100,reviewTasks?:boolean,permissionCeiling:read_only|workspace_write|workspace_write_net|full_access,budgetUsd}. Applied authority permits initiative owner and proposing chief to assign tasks within these bounds. Budget is a reservation; provider cost reporting may lag.",
          assign:
            "request {value:<task value above>,planId}. Stable key. Optional managers/initiatives for human-created direct work. Agent assignments require applied initiative authority.",
          review:
            "request {taskId,revision,decision:accept|changes|reject,feedback?,planId}. Requires explicit reviewTasks authority; never review your own execution. Initiative completion stays human-reviewed.",
          brief:
            "request {projectId,summary?}; saves dated evidence and summary. Initiative/remit versions start at 1; edits increment. Dates are ISO timestamps. No cross-workspace moves. Busy chats move only at safe boundaries; running task accountability transfers after execution. Completed initiatives require accepted or explicitly cancelled tasks.",
        };
      if (["shape_read", "create", "update", "review"].includes(args.action)) {
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
      const { section, id, offset, ...request } = args.request ?? {};
      const result = await api(
        `company.${args.action}`,
        args.action === "read" ? request : (args.request ?? {}),
        commandId,
        call.actor,
      );
      if (result === undefined) throw Error("unknown_company_action");
      if (args.action === "read") {
        let view = compactCompanyView(result);
        if (typeof section === "string") view = { [section]: view[section] ?? [] };
        for (const [key, value] of Object.entries(view))
          if (Array.isArray(value))
            view[key] = value
              .filter((r) => !id || r.id === id)
              .slice(typeof offset === "number" ? offset : 0);
        const counts = Object.fromEntries(
          Object.entries(view)
            .filter(([, v]) => Array.isArray(v))
            .map(([k, v]) => [k, (v as unknown[]).length]),
        );
        while (JSON.stringify(view).length > 3400) {
          const largest = Object.entries(view)
            .filter(([, v]) => Array.isArray(v) && v.length > 0)
            .sort((a, b) => JSON.stringify(b[1]).length - JSON.stringify(a[1]).length)[0];
          if (!largest) break;
          const value = largest[1] as unknown[];
          if (value.length === 1) {
            view[largest[0]] = JSON.parse(
              JSON.stringify(value, (_k, v) =>
                typeof v === "string" && v.length > 160 ? `${v.slice(0, 160)}…` : v,
              ),
            );
            if (JSON.stringify(view).length > 3400) view[largest[0]] = [];
          } else view[largest[0]] = value.slice(0, Math.ceil(value.length / 2));
        }
        return {
          ...view,
          counts,
          hint: "Select request section/id and offset for omitted records. Full records are available in the workspace.",
        };
      }
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
      return result;
    },
  };
}
