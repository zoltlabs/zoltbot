// A1: agent templates, over IPC. Picking one fills the new-agent form; the profile keeps its id.
import type { BotSummary } from "./ipc";

export const AGENT_TEMPLATE_CHANNELS = {
  agentTemplatesList: "agent-templates:list",
  agentTemplatesCreate: "agent-templates:create",
} as const;

export interface AgentTemplateSummary {
  id: string;
  name: string;
  role: string;
  instructions: string;
}

export interface CreateFromTemplateInput {
  /** Made once per pick, so a retry reuses the same profile instead of making another. */
  requestId: string;
  templateId: string;
  name: string;
  role: string;
  instructions: string;
  projectId: string | null;
}

export interface AgentTemplatesDesktopApi {
  list: () => Promise<AgentTemplateSummary[]>;
  create: (input: CreateFromTemplateInput) => Promise<BotSummary>;
}
