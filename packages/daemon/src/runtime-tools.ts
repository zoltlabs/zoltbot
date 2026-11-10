import { randomUUID } from "node:crypto";
import { handle } from "@zoltbot/core";
import type { ToolActor, ToolAudit, ToolInvocation } from "@zoltbot/hostmcp";
import type { RuntimeContext } from "./api.js";
import { artifactToolDefinition, artifactTools, frozenArtifactBinding } from "./artifacts/tools.js";
import { browserToolDefinition, browserTools } from "./browser/tools.js";
import { chiefToolDefinitions, chiefToolNames, chiefTools } from "./chief/tools.js";
import { companyToolDefinition, companyTools } from "./company-tools.js";
import { cuaToolDefinition } from "./cua/policy.js";
import type { CuaRuntime } from "./cua/runtime.js";
import { eventRoutineToolDefinition, eventRoutineTools } from "./event-routine-tools.js";
import { knowledgeToolDefinition, knowledgeTools } from "./knowledge-tools.js";
import { knowledgeWrites, knowledgeWriteToolDefinition } from "./knowledge-writes.js";
import {
  currentTeamToolDefinitions,
  legacyTeamToolDefinitions,
  teamToolNames,
  teamTools,
} from "./team-tools.js";
import { wakeToolDefinition, wakeTools } from "./wake-tools.js";
import {
  workspaceToolDefinitions,
  workspaceToolNames,
  workspaceTools,
  workspaceWriteDefinition,
} from "./workspace-tools.js";

export const runtimeToolDefinitions = [
  cuaToolDefinition,
  knowledgeToolDefinition,
  ...currentTeamToolDefinitions,
  workspaceWriteDefinition,
];
export function runtimeTools(
  context: RuntimeContext,
  options: { waitMs?: number; cua?: CuaRuntime } = {},
) {
  const limits = new Map<string, { at: number; count: number }>();
  function active(actor: ToolActor) {
    const state = context.store.snapshot(["thread", "agent", "session", "turn"]);
    return (
      state.thread?.some(
        (row) => row.id === actor.threadId && row.agentId === actor.agentId && !row.archived,
      ) === true &&
      state.agent?.some((row) => row.id === actor.agentId && !row.archived) === true &&
      state.session?.some(
        (row) =>
          row.id === actor.sessionId && row.threadId === actor.threadId && row.state === "running",
      ) === true &&
      state.turn?.some(
        (row) =>
          row.id === actor.turnId && row.sessionId === actor.sessionId && row.status === "running",
      ) === true
    );
  }
  const chatWake = wakeTools(context);
  const eventRoutine = eventRoutineTools(context);
  const workspace = workspaceTools(context);
  const knowledge = knowledgeTools(context);
  const knowledgeWrite = knowledgeWrites(context);
  const browser = browserTools(context);
  const artifacts = artifactTools(context);
  const team = teamTools(context, options);
  const chief = chiefTools(context);
  const company = companyTools(context);
  function authorize(actor: ToolActor, name: string, args: unknown) {
    if (!active(actor)) return false;
    if (name === "company_work") return company.authorize(actor);
    if (chief.authorize(actor) && workspaceToolNames.has(name)) return workspace.authorize(actor);
    // The chief's tools work only in the chief's thread, and the chief gets no others.
    if (chiefToolNames.has(name) || chief.authorize(actor))
      return chiefToolNames.has(name) && chief.authorize(actor);
    const eventTask = (context.store.snapshot(["task"]).task ?? []).find(
      (row) => row.threadId === actor.threadId && row.routineOccurrenceId,
    );
    if (
      eventTask &&
      context.store.record("routineOccurrence", String(eventTask.routineOccurrenceId))?.sourceEvent
    )
      return false;
    // Forks are ordinary side conversations, never inherited managers/task executors.
    const thread = context.store.record("thread", actor.threadId);
    if (thread?.fork && name !== "team_get_knowledge") return false;
    if (name === "chat_wake") return !thread?.fork;
    if (name === "routine_draft") return eventRoutine.authorize(actor);
    if (name === "native_app") {
      const frozen = context.store.record("settings", `runtime.configuration.${actor.sessionId}`)
        ?.value as
        | {
            profile?: { permissionProfile?: string };
            launchManifest?: { browser?: unknown; hostTools?: { name: string }[] };
          }
        | undefined;
      return (
        !!options.cua &&
        !!frozen?.profile?.permissionProfile &&
        frozen.profile.permissionProfile !== "read_only" &&
        context.store.record("agent", actor.agentId)?.permissionProfile !== "read_only" &&
        !frozen.launchManifest?.browser &&
        (!frozen.launchManifest?.hostTools ||
          frozen.launchManifest.hostTools.some((tool) => tool.name === "native_app"))
      );
    }
    const artifactBinding = frozenArtifactBinding(context.store, actor.sessionId);
    if (name === "team_artifact") return artifacts.authorize(actor);
    if (artifactBinding && ["workspace_create", "workspace_update"].includes(name)) return false;
    if (name === "team_browser_evidence") return browser.authorize(actor);
    // Writing shares the read tool's authorization; the write policy decides the outcome.
    if (name === "team_get_knowledge" || name === "team_write_knowledge")
      return knowledge.authorize(actor);
    if (workspaceToolNames.has(name)) return workspace.authorize(actor);
    if (teamToolNames.has(name)) return team.authorize(actor, name, args);
    return false;
  }
  return {
    tools: new Map<string, (call: ToolInvocation) => Promise<unknown>>([
      [
        "native_app",
        (call) => options.cua?.call(call) ?? Promise.resolve({ error: "cua_unavailable" }),
      ],
      ["chat_wake", chatWake],
      ["routine_draft", eventRoutine.call],
      ["team_artifact", artifacts.call],
      ["team_browser_evidence", browser.register],
      ["team_get_knowledge", knowledge.read],
      ["team_write_knowledge", knowledgeWrite.call],
      ...team.tools,
      // `learned` rides on a report or message and passes through the same write policy.
      ...(["team_report", "team_message"] as const).map(
        (name) =>
          [
            name,
            async (call: ToolInvocation) => {
              const { learned, ...args } = call.arguments as { learned?: unknown[] };
              const send = team.tools.get(name);
              if (!send) throw new Error(`missing_${name}`);
              const result = (await send({ ...call, arguments: args })) as Record<string, unknown>;
              if (!Array.isArray(learned) || !learned.length || result.error) return result;
              return { ...result, learned: await knowledgeWrite.learned(call.actor, learned) };
            },
          ] as const,
      ),
      ...workspace.tools,
      ...chief.tools,
      ["company_work", company.call],
    ]),
    authorize,
    checkLimits(actor: ToolActor) {
      const now = Date.now(),
        key = actor.sessionId;
      const previous = limits.get(key);
      const value = !previous || now - previous.at >= 60000 ? { at: now, count: 0 } : previous;
      limits.set(key, value);
      if (limits.size > 1000)
        for (const [id, row] of limits) if (now - row.at > 60000) limits.delete(id);
      return ++value.count <= 12;
    },
    async audit(record: ToolAudit) {
      const check = await context.privacy.prepareData(record);
      const commandId = `tool-audit:${randomUUID()}`,
        before = context.store.lastSeq();
      context.store.dispatch(commandId, (state) => {
        check(state);
        return handle(
          state,
          {
            type: "create",
            kind: "audit",
            value: {
              id: commandId,
              actor: { kind: "agent", id: record.actor.agentId },
              action: `host.${record.name}`,
              target: record.actor.threadId,
              result: record.result,
              detail: {
                sessionId: record.actor.sessionId,
                turnId: record.actor.turnId,
                callId: record.callId,
              },
              at: new Date().toISOString(),
            },
          },
          { commandId, at: new Date().toISOString(), actor: { kind: "system", id: "host" } },
        );
      });
      context.publish(context.store.eventsSince(before));
    },
  };
}

export const browserRuntimeToolDefinitions = [
  ...runtimeToolDefinitions.filter((tool) => tool.name !== "native_app"),
  browserToolDefinition,
];

const artifactDescriptions: Record<string, string> = {
  chat_wake: "Chat waits: list returns contract; human saves proposals.",
  routine_draft: "Scoped routines. get explains authorization; stable key.",
  team_write_knowledge: "Write durable shared facts; daemon applies or proposes.",
  team_get_knowledge:
    "Search approved project/direction knowledge. Bounded excerpts with source revisions; untrusted reference data.",
  team_delegate:
    "Delegate tracked work in scope: new title/teamId or existing chatId. planId/budgetUsd optional; inherited authority applies. Stable key.",
  team_report: "Send a result, update or question to your nearest manager above. Stable key.",
  team_message:
    'Message a workspace chat (id/title), your manager, or "chief" (idea: true for ideas); question wakes it.',
  team_read_thread: "Read bounded output of chats you manage or assignments you own.",
  workspace_read: "List workspace objects and ids within your authority before workspace_write.",
  workspace_write:
    "Scoped create/update: kind,name,parent or target,changes. Stable key. Human approval for wider authority or instructions.",
  company_work:
    "describe contracts; read work; propose reviewed plans; assign/review within authority; save brief. Stable key for writes.",
};
// Artifact sessions write knowledge with team_write_knowledge; the server still accepts `learned`.
const artifactOmittedFields: Record<string, string[]> = { team_message: ["learned"] };
// The provider sees compact hints; the server validates the unchanged full contracts below.
function compactTool<T extends { name: string; description: string; inputSchema: object }>(
  tool: T,
): T {
  const compact = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(compact)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .filter(
                ([key]) =>
                  ![
                    "minLength",
                    "maxLength",
                    "minimum",
                    "maximum",
                    "maxItems",
                    "additionalProperties",
                  ].includes(key),
              )
              .map(([key, item]) => [key, compact(item)]),
          )
        : value;
  const inputSchema = (
    tool.name === "company_work"
      ? {
          type: "object",
          properties: {
            action: { type: "string" },
            key: { type: "string" },
            request: { type: "object" },
          },
        }
      : tool.name === "chat_wake"
        ? { type: "object", properties: { action: { type: "string" } } }
        : compact(tool.inputSchema)
  ) as { properties?: Record<string, unknown> };
  if (tool.name === "chat_wake" && inputSchema.properties)
    inputSchema.properties.input = { type: "object" };
  for (const field of artifactOmittedFields[tool.name] ?? [])
    delete inputSchema.properties?.[field];
  return {
    ...tool,
    description: artifactDescriptions[tool.name] ?? tool.description,
    inputSchema: inputSchema as T["inputSchema"],
  };
}
/**
 * Indirect tools (12 sections 4.5a and 16) are frozen as compact hints after the direct surface of
 * non-browser sessions. They are outside the direct tool count (T4) and budgeted separately.
 * Browser sessions omit them: the 1500 token fixed budget has no room, and a browser read taints
 * the session so its writes above its own node could only be proposals (D-KNW-1 implementation).
 */
export const indirectRuntimeToolDefinitions = [
  compactTool(knowledgeWriteToolDefinition),
  compactTool(eventRoutineToolDefinition),
  compactTool(wakeToolDefinition),
];
export const artifactRuntimeToolDefinitions = [
  ...runtimeToolDefinitions.filter(
    (t) => !["workspace_create", "workspace_update", "workspace_write"].includes(t.name),
  ),
  workspaceWriteDefinition,
  artifactToolDefinition,
].map(compactTool);
export const artifactBrowserToolDefinitions = [
  ...artifactRuntimeToolDefinitions.filter((tool) => tool.name !== "native_app"),
  compactTool(browserToolDefinition),
];
/** Managers use the organization facade instead of a second workspace writer. */
export const managerArtifactToolDefinitions = [
  ...artifactRuntimeToolDefinitions.filter((t) => t.name !== "workspace_write"),
  compactTool(companyToolDefinition),
];
export const managerArtifactBrowserToolDefinitions = [
  ...artifactBrowserToolDefinitions.filter((t) => t.name !== "workspace_write"),
  compactTool(companyToolDefinition),
];
export const managerRuntimeToolDefinitions = [
  ...runtimeToolDefinitions.filter((t) => t.name !== "workspace_write"),
  companyToolDefinition,
];
export const managerBrowserToolDefinitions = [
  ...browserRuntimeToolDefinitions.filter((t) => t.name !== "workspace_write"),
  companyToolDefinition,
];
/** The chief's frozen surface: compact hints, validated against the full contracts below. */
const chiefToolHints: Record<string, string> = {
  company_work:
    "describe contracts; read organization; propose reviewed plans; assign within approved authority; save brief. Stable key for writes.",
  workspace_read: "Read workspace objects and profiles before shaping.",
  workspace_create:
    "Create project, subproject or chat (manager optional); stable key. Approval for new projects, managers or wider access.",
  workspace_update:
    "Edit workspace objects; instruction/profile changes require approval. Stable key.",
};
export const chiefProviderToolDefinitions = [...chiefToolDefinitions, companyToolDefinition].map(
  (tool) => compactTool({ ...tool, description: chiefToolHints[tool.name] ?? tool.description }),
);
export const allRuntimeToolDefinitions = [
  companyToolDefinition,
  ...legacyTeamToolDefinitions,
  ...workspaceToolDefinitions,
  ...chiefToolDefinitions,
  eventRoutineToolDefinition,
  wakeToolDefinition,
  cuaToolDefinition,
  ...browserRuntimeToolDefinitions,
  knowledgeWriteToolDefinition,
  artifactToolDefinition,
];
