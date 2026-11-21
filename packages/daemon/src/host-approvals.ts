import type { Interaction, InteractionAnswer } from "@zoltbot/protocol";
import type { RuntimeContext } from "./api-types.js";
/** Dispatch only daemon-created host requests; native requests keep their existing responder. */
export function respondHostApproval(
  context: RuntimeContext,
  request: Interaction,
  answer: InteractionAnswer,
) {
  const input = request.context?.toolInput as
    | {
        cuaSession?: string;
        worktreeExecution?: boolean;
        chiefAction?: unknown;
        chiefIdea?: unknown;
        viewProposal?: string;
        backupSwitch?: unknown;
        staffChange?: unknown;
        vaultFill?: string;
      }
    | undefined;
  if (input?.cuaSession)
    return import("./cua/approval.js").then((tools) =>
      tools.respondCuaApproval(context, request, answer),
    );
  // The backup supervisor reads the answer from the store.
  if (input?.worktreeExecution || input?.backupSwitch) return Promise.resolve();
  if (input?.chiefAction)
    return import("./chief/tools.js").then((tools) =>
      tools.respondChiefApproval(context, request, answer),
    );
  if (input?.chiefIdea)
    return import("./chief/tools.js").then((tools) =>
      tools.respondChiefIdea(context, request, answer),
    );
  if (input?.viewProposal)
    return import("./views/tool-save.js").then((tools) =>
      tools.respondViewApproval(context, request, answer),
    );
  if (input?.vaultFill)
    return import("./vault/tools.js").then((tools) =>
      tools.respondVaultApproval(context, request, answer),
    );
  if (input?.staffChange)
    return import("./staff-tools.js").then((tools) =>
      tools.respondStaffApproval(context, request, answer),
    );
  return import("./workspace-tools.js").then((tools) =>
    tools.respondWorkspaceApproval(context, request, answer),
  );
}
