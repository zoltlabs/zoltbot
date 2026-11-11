import type { ToolInvocation } from "@zoltbot/hostmcp";
import type { RuntimeContext } from "../api-types.js";
import { viewActor } from "./tool-owner.js";
import { readViewTool } from "./tool-read.js";
import { saveViewTool } from "./tool-save.js";

const id = { type: "string", pattern: "^[a-z0-9-]{2,40}$" },
  hash = { type: "string", pattern: "^[a-f0-9]{64}$" };
export const viewToolDefinition = {
  name: "team_view",
  description:
    "List/read checked page views or save staged file overlays. Read with id,bundleHash,path,cursor. Save id,baseHash,source.dir,key; stage under .zoltbot/staging/<uuid> in the frozen working folder. Existing views need owner consent unless created in this chat. Grants never change.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: { type: "string", enum: ["list", "read", "save"] },
      id,
      bundleHash: hash,
      baseHash: hash,
      path: { type: "string", minLength: 1, maxLength: 512 },
      cursor: { type: "string", maxLength: 700 },
      key: { type: "string", minLength: 1, maxLength: 100 },
      source: {
        type: "object",
        properties: { dir: { type: "string", minLength: 1, maxLength: 512 } },
        required: ["dir"],
        additionalProperties: false,
      },
    },
    required: ["action"],
    additionalProperties: false,
  },
};
export const viewToolHint = {
  ...viewToolDefinition,
  description:
    "Views: list; read id/path/bundleHash; save id/source.dir/baseHash/key. Owner consent for edits.",
  inputSchema: {
    type: "object" as const,
    properties: { action: { type: "string" } },
    required: ["action"],
  },
};
export function viewTools(context: RuntimeContext) {
  return {
    authorize(actor: ToolInvocation["actor"], args: unknown) {
      try {
        viewActor(
          context,
          actor,
          !!args && typeof args === "object" && "action" in args && args.action === "save",
        );
        return true;
      } catch {
        return false;
      }
    },
    async call(call: ToolInvocation) {
      const args = call.arguments as { action?: string };
      if (args.action === "save") return saveViewTool(context, call);
      if (args.action === "list" || args.action === "read") return readViewTool(context, call);
      throw Error("unknown_view_action");
    },
  };
}
