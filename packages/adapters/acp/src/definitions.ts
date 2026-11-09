import { type AgentDefinition, AgentDefinitionSchema, parse } from "@zoltbot/protocol";
import antigravity from "../definitions/antigravity.json" with { type: "json" };
import cline from "../definitions/cline.json" with { type: "json" };
import copilot from "../definitions/copilot.json" with { type: "json" };
import cursor from "../definitions/cursor.json" with { type: "json" };
import goose from "../definitions/goose.json" with { type: "json" };
import grok from "../definitions/grok.json" with { type: "json" };
import kimi from "../definitions/kimi.json" with { type: "json" };
import opencode from "../definitions/opencode.json" with { type: "json" };
import qwen from "../definitions/qwen.json" with { type: "json" };
export const acpDefinitions: AgentDefinition[] = [
  cursor,
  opencode,
  grok,
  cline,
  goose,
  qwen,
  kimi,
  copilot,
  antigravity,
].map((value) => parse(AgentDefinitionSchema, value));
