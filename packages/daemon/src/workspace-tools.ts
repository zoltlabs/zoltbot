import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  applyEvents,
  applyWorkspaceChange,
  planWorkspaceChange,
  queueHumanInput,
  readWorkspace,
  requestInteraction,
  type WorkspaceActor,
  type WorkspaceRequest,
} from "@zoltbot/core";
import type { ToolActor, ToolInvocation } from "@zoltbot/hostmcp";
import { HOST_WORKSPACE_REF, type Interaction, type InteractionAnswer } from "@zoltbot/protocol";
import type { RuntimeContext } from "./api.js";

const Name = { type: "string", minLength: 1, maxLength: 150 };
const Key = { type: "string", minLength: 1, maxLength: 100 };
const Ref = { type: "string", minLength: 1, maxLength: 256 };
export const workspaceToolDefinitions = [
  {
    name: "workspace_read",
    description:
      "List the projects, sub-projects, chats and profiles you may shape, with ids. Call before workspace_create or workspace_update.",
    inputSchema: {
      type: "object" as const,
      properties: { projectId: Ref },
      additionalProperties: false,
    },
  },
  {
    name: "workspace_create",
    description:
      "Create a project, sub-project or chat under parent. Stable key. New projects, deeper levels, manager chats and wider permissions await human approval; pending outcomes arrive by message.",
    inputSchema: {
      type: "object" as const,
      properties: {
        key: Key,
        kind: { type: "string", enum: ["project", "subproject", "chat"] },
        name: Name,
        parent: {
          type: "object",
          properties: { type: { type: "string", enum: ["project", "subproject"] }, id: Ref },
          required: ["type", "id"],
          additionalProperties: false,
        },
        goal: { type: "string", maxLength: 2000 },
        profileId: Ref,
        manager: { type: "boolean" },
      },
      required: ["key", "kind", "name"],
      additionalProperties: false,
    },
  },
  {
    name: "workspace_update",
    description:
      "Rename or edit a project, sub-project, chat or profile. Instruction and profile changes, except narrowing permissionProfile, wait for human approval.",
    inputSchema: {
      type: "object" as const,
      properties: {
        key: Key,
        target: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["project", "subproject", "chat", "profile"] },
            id: Ref,
          },
          required: ["type", "id"],
          additionalProperties: false,
        },
        changes: {
          type: "object",
          minProperties: 1,
          additionalProperties: { type: "string", maxLength: 4000 },
        },
      },
      required: ["key", "target", "changes"],
      additionalProperties: false,
    },
  },
];
export const workspaceWriteDefinition = {
  name: "workspace_write",
  description:
    "Create or update scoped workspace objects. action=create uses kind,name,parent,goal,profileId,manager; action=update uses target,changes. Stable key required. Widening or instruction changes await human approval.",
  inputSchema: {
    type: "object" as const,
    properties: {
      ...workspaceToolDefinitions[1]?.inputSchema.properties,
      ...workspaceToolDefinitions[2]?.inputSchema.properties,
      action: { type: "string", enum: ["create", "update"] },
    },
    required: ["action", "key"],
    additionalProperties: false,
  },
};
export const workspaceToolNames = new Set([
  ...workspaceToolDefinitions.map((tool) => tool.name),
  "workspace_write",
]);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

interface Args {
  key?: string;
  kind?: "project" | "subproject" | "chat";
  name?: string;
  parent?: { type: "project" | "subproject"; id: string };
  goal?: string;
  profileId?: string;
  manager?: boolean;
  target?: { type: "project" | "subproject" | "chat" | "profile"; id: string };
  changes?: Record<string, string>;
  projectId?: string;
}
function toRequest(name: string, args: Args): WorkspaceRequest {
  if (name === "workspace_update" && args.target && args.changes)
    return { tool: "update", target: args.target, changes: args.changes };
  if (name !== "workspace_create" || !args.name) throw new Error("invalid_tool_arguments");
  if (args.kind === "project")
    return {
      tool: "create",
      kind: "project",
      name: args.name,
      ...(args.goal ? { goal: args.goal } : {}),
    };
  if (!args.parent) throw new Error("parent_required");
  if (args.kind === "subproject")
    return {
      tool: "create",
      kind: "subproject",
      name: args.name,
      parent: args.parent,
      ...(args.goal ? { goal: args.goal } : {}),
    };
  return {
    tool: "create",
    kind: "chat",
    title: args.name,
    parent: args.parent,
    ...(args.profileId ? { profileId: args.profileId } : {}),
    ...(args.manager ? { manager: true } : {}),
  };
}
function describe(request: WorkspaceRequest, reasons: string[]) {
  const what =
    request.tool === "update"
      ? `update ${request.target.type} \`${request.target.id}\`: ${Object.entries(request.changes)
          .map(([key, value]) => `${key} → "${value.slice(0, 200)}"`)
          .join(", ")}`
      : request.kind === "chat"
        ? `create ${request.manager ? "a manager" : "a"} chat "${request.title}" in ${request.parent.type} \`${request.parent.id}\``
        : request.kind === "subproject"
          ? `create sub-project "${request.name}" in ${request.parent.type} \`${request.parent.id}\``
          : `create project "${request.name}"`;
  return `Wants to ${what}. Needs approval because: ${reasons.join(", ").replaceAll("_", " ")}.`;
}

export function workspaceTools(context: RuntimeContext) {
  const actorOf = (actor: ToolActor): WorkspaceActor => ({
    agentId: actor.agentId,
    threadId: actor.threadId,
  });
  async function change(name: string, call: ToolInvocation) {
    const args = call.arguments as Args;
    const request = toRequest(name, args);
    const actor = actorOf(call.actor);
    const digest = hash([name, request]);
    const base = hash([call.actor.threadId, name, args.key]);
    const kind = request.tool === "create" ? request.kind : request.target.type;
    const id = request.tool === "create" ? `${kind}-${base.slice(0, 24)}` : request.target.id;
    const commandId = `workspace:${base}`;
    const check = await context.privacy.prepareData(request);
    const before = context.store.lastSeq();
    let produced = false;
    const receipt = context.store.dispatch<Record<string, unknown>>(commandId, (state) => {
      check(state);
      produced = true;
      const at = new Date().toISOString();
      const ctx = { commandId, at, actor: { kind: "agent" as const, id: actor.agentId } };
      const reasons = planWorkspaceChange(state, actor, request);
      if (!reasons.length) {
        const applied = applyWorkspaceChange(state, actor, request, id, ctx);
        return { ...applied, result: { status: "done", ...applied.result, digest } };
      }
      const interactionId = `workspace-approval-${base.slice(0, 32)}`;
      const requested = requestInteraction(
        state,
        {
          id: interactionId,
          agentId: actor.agentId,
          threadId: actor.threadId,
          type: "approval",
          title: "Workspace change",
          context: {
            toolName: name,
            markdown: describe(request, reasons),
            toolInput: { actor, request, id, reasons },
          },
          items: [
            {
              id: "change",
              header: "Workspace",
              prompt: describe(request, reasons),
              choices: [{ id: "allow_once" }, { id: "reject_once" }],
            },
          ],
          chain: [{ kind: "agent", id: actor.agentId }],
          urgency: "background",
          nativeRef: HOST_WORKSPACE_REF,
        },
        `${interactionId}:item`,
        ctx,
      );
      return {
        events: requested.events,
        result: { status: "pending", interactionId, reasons, digest },
      };
    });
    const result = receipt.result;
    if (!isDeepStrictEqual(result.digest, digest)) throw new Error("command_receipt_conflict");
    if (produced) context.publish(context.store.eventsSince(before));
    const { digest: _digest, ...visible } = result;
    return result.status === "pending"
      ? { ...visible, note: "A human must approve this. The outcome arrives as a later message." }
      : visible;
  }
  return {
    tools: new Map<string, (call: ToolInvocation) => Promise<unknown>>([
      [
        "workspace_read",
        async (call) => {
          const view = readWorkspace(
            context.store.snapshot(),
            actorOf(call.actor),
            (call.arguments as Args).projectId,
          );
          const result: Record<string, unknown> = { ...view };
          // Keep the result under the dispatcher's 4,000 character bound.
          while (JSON.stringify(result).length > 3800) {
            const list = (["chats", "subprojects", "profiles", "projects"] as const).find(
              (key) => (result[key] as unknown[]).length > 0,
            );
            if (!list) break;
            result[list] = (result[list] as unknown[]).slice(
              0,
              Math.floor((result[list] as unknown[]).length / 2),
            );
            result.truncated = true;
          }
          return result;
        },
      ],
      [
        "workspace_write",
        (call) => {
          const args = call.arguments as Args & { action?: string };
          if (
            args.action === "create" &&
            ["project", "subproject", "chat"].includes(args.kind ?? "") &&
            typeof args.name === "string"
          )
            return change("workspace_create", call);
          if (args.action === "update" && args.target && args.changes)
            return change("workspace_update", call);
          throw Error("invalid_tool_arguments");
        },
      ],
      ["workspace_create", (call) => change("workspace_create", call)],
      ["workspace_update", (call) => change("workspace_update", call)],
    ]),
    authorize(actor: ToolActor) {
      try {
        // Throws grant_required when the actor holds no workspace authority.
        readWorkspace(
          context.store.snapshot(["thread", "agent", "grant", "settings"]),
          actorOf(actor),
        );
        return true;
      } catch {
        return false;
      }
    },
  };
}

function outcome(request: WorkspaceRequest, result: Record<string, unknown>) {
  return request.tool === "create"
    ? `created ${request.kind} "${request.kind === "chat" ? request.title : request.name}" with id ${String(result.id)}`
    : `updated ${request.target.type} ${request.target.id}`;
}
/** Applies or declines a D119 approval and tells the requesting chat through its input queue. */
export async function respondWorkspaceApproval(
  context: RuntimeContext,
  request: Interaction,
  answer: InteractionAnswer,
) {
  if (answer.by.kind !== "human") throw new Error("human_answer_required");
  const stored = request.context?.toolInput as
    | { actor: WorkspaceActor; request: WorkspaceRequest; id: string }
    | undefined;
  if (!stored) throw new Error("workspace_request_missing");
  const approved = answer.action === "accept" && answer.choice === "allow_once";
  const commandId = `workspace-approval:${request.id}`;
  const queue = (
    state: Parameters<typeof queueHumanInput>[0],
    text: string,
    at: string,
    suffix: string,
  ) =>
    queueHumanInput(
      state,
      {
        threadId: request.threadId,
        input: [{ type: "text", text: `[Zoltbot] ${text}` }],
        mode: "queue",
        sourceInteractionId: request.id,
      },
      `${commandId}:${suffix}`,
      { commandId: `${commandId}:${suffix}`, at, actor: answer.by },
    );
  const before = context.store.lastSeq();
  try {
    context.store.dispatch(commandId, (state) => {
      const at = new Date().toISOString();
      const ctx = { commandId, at, actor: answer.by };
      if (!approved) {
        const why = answer.feedback?.trim() ? ` Reason: ${answer.feedback.trim()}` : "";
        return queue(
          state,
          `Your ${request.context?.toolName ?? "workspace"} request was declined.${why}`,
          at,
          "declined",
        );
      }
      const applied = applyWorkspaceChange(state, stored.actor, stored.request, stored.id, ctx, {
        interactionId: request.id,
      });
      const queued = queue(
        applyEvents(state, applied.events),
        `Approved: ${outcome(stored.request, applied.result as Record<string, unknown>)}.`,
        at,
        "approved",
      );
      return {
        events: [...applied.events, ...queued.events].map((event, index) => ({
          ...event,
          eventId: `${commandId}:${index}`,
        })),
        result: applied.result,
      };
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : "workspace_change_failed";
    const failed = `${commandId}:failed:${randomUUID()}`;
    context.store.dispatch(failed, (state) =>
      queue(
        state,
        `Approved, but the change could not be applied (${code.slice(0, 80)}).`,
        new Date().toISOString(),
        `failed:${failed.slice(-36)}`,
      ),
    );
  }
  context.publish(context.store.eventsSince(before));
  try {
    await context.wake(request.threadId);
  } catch {}
}
