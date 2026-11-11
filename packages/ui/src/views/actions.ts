import type { ViewRecord } from "@zoltbot/protocol";
import { mapRequests, type Request, type ViewSnapshot } from "@zoltbot/view-api";
import { ViewCallError } from "./bridge.js";
export interface ViewActionHost {
  record(): ViewRecord;
  snapshot(): ViewSnapshot;
  call(method: string, params: Record<string, unknown>, commandId: string): Promise<unknown>;
  confirm(request: Request, choice: Request["choices"][number]): Promise<boolean>;
  open(target: { chatId?: string; page?: string }): void;
}
export function viewActions(host: ViewActionHost) {
  return async (method: string, params: unknown) => {
    const input = params as Record<string, unknown>;
    const permission =
      method === "requests.answer" ? "approve" : method.startsWith("chats.") ? "act" : "read";
    const check = () => {
      const record = host.record();
      if (
        !record.enabled ||
        !record.granted.includes("read") ||
        !record.granted.includes(permission)
      )
        throw new ViewCallError("not_granted", `This view needs the ${permission} permission.`);
    };
    check();
    if (method === "app.open") {
      if (input.chatId && !host.snapshot().entities.thread?.some((row) => row.id === input.chatId))
        throw new ViewCallError("not_found", "Chat not found.");
      host.open(input);
      return;
    }
    let confirmed = false;
    if (method === "requests.answer") {
      const current = () => {
        check();
        const request = mapRequests(host.snapshot()).find((row) => row.id === input.requestId);
        if (!request) {
          const exists = host
            .snapshot()
            .entities.interaction?.some((row) => row.id === input.requestId);
          throw new ViewCallError(
            exists ? "stale" : "not_found",
            exists ? "This request changed. Read it again." : "Request not found.",
          );
        }
        if (request.version !== input.version)
          throw new ViewCallError("stale", "This request changed. Read it again.");
        return request;
      };
      const request = current();
      const choice = request.choices.find((row) => row.id === input.choiceId);
      if (input.choiceId !== undefined && !choice)
        throw new ViewCallError("invalid", "This choice was not offered.");
      if (choice?.widens) {
        if (!(await host.confirm(request, choice)))
          throw new ViewCallError("declined", "You declined this answer.");
        current();
        confirmed = true;
      }
    }
    if (!["chats.send", "chats.interrupt", "requests.answer"].includes(method))
      throw new ViewCallError("invalid", "Unknown view call.");
    check();
    try {
      const result = await host.call(
        "view.call",
        {
          id: host.record().id,
          method,
          params: input,
          ...(confirmed ? { confirmed: true } : {}),
        },
        crypto.randomUUID(),
      );
      return method === "requests.answer" ? undefined : result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "The call failed.";
      const code = message.includes("not_granted")
        ? "not_granted"
        : /stale|interaction_conflict|interaction_expired/.test(message)
          ? "stale"
          : /not_found/.test(message)
            ? "not_found"
            : /invalid|confirmation_required/.test(message)
              ? "invalid"
              : "unavailable";
      throw new ViewCallError(code, message);
    }
  };
}
