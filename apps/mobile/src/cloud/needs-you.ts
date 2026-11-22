import { approvalStdinHash, type Identity, linkId, signApproval } from "@zoltbot/link";
import { type Interaction, InteractionSchema, parse } from "@zoltbot/protocol";
import type { AnswerDraft } from "../data/interactions.js";
import type { Snapshot } from "../data/transport.js";
import type { PhoneCellConnection } from "./account.js";

type Owner = PhoneCellConnection["owner"];

export function cloudRequests(snapshot: Snapshot, threadId?: string) {
  return (snapshot.entities.interaction ?? [])
    .flatMap((row) => {
      if (row.state !== "pending" || (threadId !== undefined && row.threadId !== threadId))
        return [];
      try {
        return [parse(InteractionSchema, row)];
      } catch {
        return [];
      }
    })
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function macRequestDetails(request: Interaction) {
  const draft = request.context?.macExec;
  const input = request.context?.toolInput;
  const options =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : undefined;
  if (
    !draft ||
    request.type !== "approval" ||
    draft.scope !== "command" ||
    draft.taskId !== request.taskId ||
    draft.turnId !== request.turnId ||
    draft.command !== request.context?.command ||
    draft.cwd !== request.context.cwd
  )
    return;
  const stdin = options?.stdin ?? "";
  if (
    typeof stdin !== "string" ||
    approvalStdinHash(stdin) !== draft.stdinHash ||
    (options?.timeoutSeconds !== undefined && options.timeoutSeconds !== draft.timeoutSeconds)
  )
    return;
  const choices = request.items.flatMap((item) => item.choices ?? []);
  const prefix = choices.find((choice) => choice.id === "allow_task_prefix");
  return {
    draft,
    stdin,
    mac: typeof options?.mac === "string" && options.mac ? options.mac : draft.targetDeviceId,
    canRun: choices.some((choice) => choice.id === "allow_once"),
    prefix: prefix?.id === "allow_task_prefix" && !stdin ? prefix.prefix : undefined,
  };
}

export function cloudAnswer(
  owner: Owner,
  request: Interaction,
  draft: AnswerDraft,
  identity?: Identity,
  now = Date.now(),
) {
  if (request.state !== "pending" || draft.signedApproval) throw new Error("cloud_answer_refused");
  const answer = {
    ...draft,
    by: { kind: "human" as const, id: owner.userId },
    at: new Date(now).toISOString(),
  };
  const approval = request.context?.macExec;
  if (!approval) return answer;
  if (approval.orgId !== owner.orgId || approval.userId !== owner.userId)
    throw new Error("cloud_answer_refused");
  if (draft.action === "decline" && draft.choice === "reject_once") return answer;
  const details = macRequestDetails(request);
  const prefix = draft.choice === "allow_task_prefix";
  if (
    !details ||
    draft.action !== "accept" ||
    !identity ||
    linkId(identity.publicKey) !== owner.deviceId ||
    (prefix ? !details.prefix : draft.choice !== "allow_once" || !details.canRun)
  )
    throw new Error("cloud_answer_refused");
  return {
    ...answer,
    signedApproval: signApproval(identity, {
      ...details.draft,
      ...(prefix && details.prefix ? { scope: "prefix", command: details.prefix } : {}),
      signerDeviceId: owner.deviceId,
      issuedAt: now,
      expiresAt: now + 300000,
    }),
  };
}
