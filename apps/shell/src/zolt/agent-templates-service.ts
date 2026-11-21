// A1: list agent templates and create an agent from one. The new profile copies the provider and
// permissions of the agent a blank chat would use, and maps the template's tier to an effort.
import { templateEffort } from "@zoltbot/protocol";
import {
  AGENT_TEMPLATE_CHANNELS as C,
  type CreateFromTemplateInput,
} from "../shared/agent-templates";
import { chooseAgent } from "./agent-choice";
import type { Row } from "./daemon-client";
import { isObject, requireString } from "./parsers";
import type { ZoltService } from "./zolt-service";

type Service = Pick<ZoltService, "client" | "createBot">;
type Template = {
  id: string;
  name: string;
  role: string;
  instructions: string;
  modelTier: "fast" | "balanced" | "best";
};

const limited = (value: unknown, field: string, max: number, required = true) => {
  if (typeof value !== "string" || value.length > max) throw new Error(`${field} is invalid.`);
  if (required && !value.trim()) throw new Error(`${field} is required.`);
  return value.trim();
};

export function parseCreateFromTemplate(input: unknown): CreateFromTemplateInput {
  if (!isObject(input)) throw new Error("Invalid template request.");
  const projectId = input.projectId;
  if (projectId !== null && projectId !== undefined && typeof projectId !== "string")
    throw new Error("projectId is invalid.");
  const requestId = requireString(input.requestId, "requestId");
  if (!/^[A-Za-z0-9-]{8,64}$/.test(requestId)) throw new Error("requestId is invalid.");
  return {
    requestId,
    templateId: requireString(input.templateId, "templateId"),
    name: limited(input.name, "Name", 150),
    role: limited(input.role, "Role", 300, false),
    instructions: limited(input.instructions, "Instructions", 4000, false),
    projectId: projectId || null,
  };
}

async function templates(service: Service): Promise<Template[]> {
  const result = (await service.client.call("agent.templates.list", {})) as { items: Template[] };
  return result.items;
}

export function agentTemplateHandlers(
  service: Service,
): Record<string, (input: unknown) => unknown> {
  return {
    [C.agentTemplatesList]: async () =>
      (await templates(service)).map(({ id, name, role, instructions }) => ({
        id,
        name,
        role,
        instructions,
      })),
    [C.agentTemplatesCreate]: async (input) => {
      const request = parseCreateFromTemplate(input);
      const template = (await templates(service)).find((row) => row.id === request.templateId);
      if (!template) throw new Error("That template isn’t available.");
      const profiles = service.client
        .rows("agent")
        .filter((row) => row.archived !== true && row.hidden !== true);
      const project = request.projectId
        ? service.client.rows("project").find((row) => row.id === request.projectId)
        : undefined;
      if (request.projectId && !project) throw new Error("That project isn’t available.");
      const id = request.requestId;
      // A retry after the profile was made only starts the chat.
      if (service.client.rows("agent").some((row) => row.id === id))
        return service.createBot({
          profileId: id,
          projectId: request.projectId,
          title: request.name,
        });
      const base: Row | undefined = chooseAgent(profiles, {
        defaultAgentId: project?.defaultAgentId,
      });
      if (!base) throw new Error("Add an agent in Zoltbot first.");
      const catalog = (await service.client
        .call("model.catalog", {})
        .catch(() => ({ items: [] }))) as {
        items: { definitionId: string; effort: string[] }[];
      };
      const efforts =
        catalog.items.find((row) => row.definitionId === base.definitionId)?.effort ?? [];
      const effort =
        templateEffort(template.modelTier, efforts) ?? (base.effort as string | undefined);
      const now = new Date().toISOString();
      await service.client.call(
        "agent.create",
        {
          value: {
            id,
            templateId: template.id,
            name: request.name,
            avatar: request.name.slice(0, 1).toUpperCase(),
            kind: "profile",
            definitionId: base.definitionId,
            ...(typeof base.model === "string" && base.model ? { model: base.model } : {}),
            ...(effort ? { effort } : {}),
            permissionProfile: base.permissionProfile,
            instructions: request.instructions,
            ...(request.role ? { roleText: request.role } : {}),
            hidden: false,
            archived: false,
            createdAt: now,
            updatedAt: now,
          },
        },
        `shell:agent:${id}`,
      );
      return service.createBot({
        profileId: id,
        projectId: request.projectId,
        title: request.name,
      });
    },
  };
}
