import { AgentDefinitionSchema, parse } from "@zoltbot/protocol";
import value from "../definitions/claude.json" with { type: "json" };
export const claudeDefinitions = [parse(AgentDefinitionSchema, value)];
