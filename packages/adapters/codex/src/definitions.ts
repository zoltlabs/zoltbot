import { AgentDefinitionSchema, parse } from "@zoltbot/protocol";
import value from "../definitions/codex.json" with { type: "json" };
export const codexDefinitions = [parse(AgentDefinitionSchema, value)];
