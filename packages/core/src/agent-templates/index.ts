// A1: the shipped agent templates, one JSON file each. Order is the order the gallery shows.
import { type AgentTemplate, AgentTemplateSchema, parse } from "@zoltbot/protocol";
import backendEngineer from "./backend-engineer.json" with { type: "json" };
import bookkeeper from "./bookkeeper.json" with { type: "json" };
import codeReviewer from "./code-reviewer.json" with { type: "json" };
import dataAnalyst from "./data-analyst.json" with { type: "json" };
import designer from "./designer.json" with { type: "json" };
import devops from "./devops.json" with { type: "json" };
import executiveAssistant from "./executive-assistant.json" with { type: "json" };
import frontendEngineer from "./frontend-engineer.json" with { type: "json" };
import projectManager from "./project-manager.json" with { type: "json" };
import qaTester from "./qa-tester.json" with { type: "json" };
import recruiter from "./recruiter.json" with { type: "json" };
import researcher from "./researcher.json" with { type: "json" };
import salesAssistant from "./sales-assistant.json" with { type: "json" };
import socialMediaManager from "./social-media-manager.json" with { type: "json" };
import supportAgent from "./support-agent.json" with { type: "json" };
import technicalWriter from "./technical-writer.json" with { type: "json" };

export const agentTemplates: readonly AgentTemplate[] = [
  frontendEngineer,
  backendEngineer,
  codeReviewer,
  qaTester,
  devops,
  dataAnalyst,
  technicalWriter,
  designer,
  researcher,
  bookkeeper,
  supportAgent,
  salesAssistant,
  recruiter,
  socialMediaManager,
  executiveAssistant,
  projectManager,
].map((row) => parse(AgentTemplateSchema, row));

export function agentTemplate(id: string): AgentTemplate | undefined {
  return agentTemplates.find((row) => row.id === id);
}
