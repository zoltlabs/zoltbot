import type { Interaction } from "@zoltbot/protocol";

/** Keep the request being answered in place when another request arrives or rows reorder. */
export function selectedRequest<T extends { id: string }>(
  requests: readonly T[],
  previous?: string,
): T | undefined {
  return requests.find((request) => request.id === previous) ?? requests[0];
}

/** Ordinary approval stays one action; broader permission states its scope before submission. */
export function permissionExpansion(request: Interaction, choice?: string) {
  if (choice === "allow_session") {
    const option = request.items
      .flatMap((item) => item.choices ?? [])
      .find((option) => option.id === choice);
    const scope =
      (option && "label" in option ? option.label : undefined) ||
      request.context?.toolName ||
      "this action";
    return {
      title: "Allow for this session?",
      description: `Allows ${scope} without asking again until this coding session ends.`,
      action: "Allow for session",
    };
  }
  if (choice === "allow_accept_edits")
    return {
      title: "Approve and auto-accept edits?",
      description: "Future file edits in this coding session can run without individual approval.",
      action: "Approve and auto-accept edits",
    };
  return undefined;
}
