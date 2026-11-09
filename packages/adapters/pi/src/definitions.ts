import { type AgentDefinition, AgentDefinitionSchema, parse } from "@zoltbot/protocol";
import deepseek from "../definitions/deepseek.json" with { type: "json" };
import openrouter from "../definitions/openrouter.json" with { type: "json" };
import base from "../definitions/pi.json" with { type: "json" };
export const piDefaultDefinition = parse(AgentDefinitionSchema, base);
export const piDefinitions: AgentDefinition[] = [deepseek, openrouter].map((value) =>
  parse(AgentDefinitionSchema, value),
);
