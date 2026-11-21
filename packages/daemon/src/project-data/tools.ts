// M8: the agent tools for the project's shared database.
import type { ToolActor, ToolInvocation } from "@zoltbot/hostmcp";
import type { RuntimeContext } from "../api.js";
import { SQL_MAX_LENGTH } from "./sql-check.js";

const sqlSchema = {
  type: "object" as const,
  properties: { sql: { type: "string", minLength: 1, maxLength: SQL_MAX_LENGTH } },
  required: ["sql"],
  additionalProperties: false,
};
export const projectDbQueryDefinition = {
  name: "project_db_query",
  description:
    "Read the project's shared SQLite database with one SELECT. Returns columns and rows; truncated is true when rows were cut to fit.",
  inputSchema: sqlSchema,
};
export const projectDbExecDefinition = {
  name: "project_db_exec",
  description:
    "Write to the project's shared SQLite database, which every agent in the project uses for lists and records: one CREATE, ALTER, DROP, INSERT, UPDATE, DELETE or REPLACE. 200 MB limit.",
  inputSchema: sqlSchema,
};
export const projectDbToolNames = new Set([
  projectDbQueryDefinition.name,
  projectDbExecDefinition.name,
]);

/** The project the actor's chat belongs to, and whether its session may write. */
export function projectDbAuthority(context: RuntimeContext, actor: ToolActor) {
  const thread = context.store.record("thread", actor.threadId);
  const session = context.store.record("session", actor.sessionId);
  if (
    !thread ||
    thread.archived ||
    thread.agentId !== actor.agentId ||
    session?.threadId !== actor.threadId ||
    typeof thread.projectId !== "string" ||
    !thread.projectId
  )
    return undefined;
  const project = context.store.record("project", thread.projectId);
  if (!project || project.archived) return undefined;
  const frozen = context.store.record("settings", `runtime.configuration.${actor.sessionId}`)
    ?.value as { profile?: { permissionProfile?: string } } | undefined;
  const profile = frozen?.profile?.permissionProfile;
  const canWrite =
    !!profile &&
    profile !== "read_only" &&
    context.store.record("agent", actor.agentId)?.permissionProfile !== "read_only";
  return { projectId: thread.projectId, canWrite };
}

export function projectDbTools(context: RuntimeContext) {
  const sqlOf = (call: ToolInvocation) => {
    const args = call.arguments as Record<string, unknown>;
    if (Object.keys(args).some((key) => key !== "sql") || typeof args.sql !== "string")
      throw new Error("invalid_tool_arguments");
    return args.sql;
  };
  const run = async (call: ToolInvocation, write: boolean) => {
    const databases = context.projectData;
    if (!databases) throw new Error("project_db_unavailable");
    const authority = projectDbAuthority(context, call.actor);
    if (!authority || (write && !authority.canWrite)) throw new Error("project_db_denied");
    const sql = sqlOf(call);
    // A private value never goes into the shared file, nor comes back out of it.
    const check = await context.privacy.prepareData(sql);
    check(context.store.snapshot());
    const result = write
      ? await databases.exec(authority.projectId, sql)
      : await databases.query(authority.projectId, sql);
    const guard = await context.privacy.prepareData(result);
    guard(context.store.snapshot());
    return result;
  };
  return {
    authorize(actor: ToolActor, name: string) {
      const authority = projectDbAuthority(context, actor);
      if (!authority || !context.projectData) return false;
      return name === projectDbExecDefinition.name ? authority.canWrite : true;
    },
    tools: [
      [projectDbQueryDefinition.name, (call: ToolInvocation) => run(call, false)],
      [projectDbExecDefinition.name, (call: ToolInvocation) => run(call, true)],
    ] as const,
  };
}
