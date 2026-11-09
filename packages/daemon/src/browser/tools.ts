import type { ToolActor, ToolInvocation } from "@zoltbot/hostmcp";
import type { RuntimeContext } from "../api.js";
import { ownedBrowser, registerEvidence } from "./evidence.js";
export const browserToolDefinition = {
  name: "team_browser_evidence",
  description:
    "Register a PNG screenshot from this execution output folder. Returns an immutable canonicalPath to inspect with the native image tool. Checks and inspection claims are agent reported.",
  inputSchema: {
    type: "object" as const,
    properties: {
      path: { type: "string", minLength: 1, maxLength: 2000 },
      url: { type: "string", maxLength: 2000 },
      viewport: {
        type: "object",
        properties: {
          width: { type: "integer", minimum: 1, maximum: 20000 },
          height: { type: "integer", minimum: 1, maximum: 20000 },
        },
        required: ["width", "height"],
        additionalProperties: false,
      },
      check: { type: "string", maxLength: 500 },
      outcome: { type: "string", enum: ["passed", "failed", "partial"] },
      inspection: { type: "string", enum: ["agent_reported"] },
    },
    required: ["path", "url", "viewport", "check", "outcome"],
    additionalProperties: false,
  },
};
export function browserTools(context: RuntimeContext) {
  return {
    authorize(actor: ToolActor) {
      try {
        ownedBrowser(context.store, actor);
        return true;
      } catch {
        return false;
      }
    },
    async register(call: ToolInvocation) {
      const args = call.arguments as Parameters<typeof registerEvidence>[2];
      const check = await context.privacy.prepareData(args);
      check(context.store.snapshot());
      return registerEvidence(context.store, call.actor, args);
    },
  };
}
