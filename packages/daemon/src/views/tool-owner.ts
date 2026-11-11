import type { ToolActor } from "@zoltbot/hostmcp";
import type { RuntimeContext } from "../api-types.js";
export function viewActor(context: RuntimeContext, actor: ToolActor, write = false, active = true) {
  const store = context.store,
    thread = store.record("thread", actor.threadId),
    session = store.record("session", actor.sessionId),
    profile = store.record("agent", actor.agentId),
    turn = actor.turnId ? store.record("turn", actor.turnId) : undefined;
  const configuration = store.record("settings", `runtime.configuration.${actor.sessionId}`)
    ?.value as
    | {
        profile?: { permissionProfile?: string };
        launchManifest?: { hostTools?: { name: string }[]; browser?: unknown };
      }
    | undefined;
  if (
    !thread ||
    thread.archived ||
    thread.agentId !== actor.agentId ||
    !profile ||
    profile.archived ||
    session?.threadId !== actor.threadId ||
    typeof session.cwd !== "string" ||
    thread.fork ||
    configuration?.launchManifest?.browser ||
    !configuration?.launchManifest?.hostTools?.some((tool) => tool.name === "team_view")
  )
    throw Error("view_authority_denied");
  if (
    active &&
    (session.state !== "running" ||
      turn?.sessionId !== actor.sessionId ||
      turn.status !== "running")
  )
    throw Error("view_authority_denied");
  if (
    write &&
    (profile.permissionProfile === "read_only" ||
      configuration.profile?.permissionProfile === "read_only")
  )
    throw Error("view_write_not_allowed");
  if (!context.views) throw Error("views_unavailable");
  return { thread, session, registry: context.views };
}
