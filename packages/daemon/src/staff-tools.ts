import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  agentTemplates,
  applyEvents,
  applyStaffChange,
  planStaffChange,
  queueHumanInput,
  requestInteraction,
  setStaffAllowance,
  type WorkspaceActor,
} from "@zoltbot/core";
import type { ToolActor } from "@zoltbot/hostmcp";
import {
  HOST_WORKSPACE_REF,
  type Interaction,
  type InteractionAnswer,
  parse,
  STAFF_ALLOWANCE_OPTION,
  STAFF_APPROVAL_ITEM,
  type StaffPreview,
  type StaffRequest,
  StaffRequestSchema,
  staffMethods,
} from "@zoltbot/protocol";
import type { RuntimeContext } from "./api-types.js";

/** What `company_work` describe says about action `staff`. */
export const staffToolContract = `request {kind:'add',name,role,teamId?,profileId?,templateId?,model?,instructions?,folders?:[path],firstTask?:{title,brief}} | {kind:'change',threadId,name?,role?,model?,instructions?} | {kind:'archive',threadId,moveTo?:chatId}. templateId fills role and instructions: ${agentTemplates
  .filter((row) => row.managerFriendly)
  .map((row) => row.id)
  .join(
    ", ",
  )}. Stable key. The owner approves unless your standing allowance covers an add; the outcome arrives as a message. Archive moves queued tasks to moveTo or your manager; running work finishes first.`;

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const title = (preview: StaffPreview) =>
  preview.kind === "add"
    ? `Add ${preview.name} to ${preview.teamName || "the team"}`
    : preview.kind === "change"
      ? `Change ${preview.name}`
      : `Archive ${preview.name}`;
/** The approval's text, for clients that show it as a plain request. */
function describe(preview: StaffPreview) {
  const rows = preview.fields.map((row) =>
    row.before && row.after
      ? `${row.label}: ${row.before.slice(0, 200)} → ${row.after.slice(0, 200)}`
      : `${row.label}: ${(row.after ?? row.before ?? "").slice(0, 300)}`,
  );
  if (preview.moves?.length)
    rows.push(`Queued: ${preview.moves.map((m) => `${m.title} → ${m.to}`).join("; ")}`);
  if (preview.running) rows.push("Running work finishes first.");
  if (preview.sharedWith)
    rows.push(
      `Also changes ${preview.sharedWith} other chat${preview.sharedWith === 1 ? "" : "s"}.`,
    );
  return [title(preview), ...rows].join("\n").slice(0, 2000);
}
interface Stored {
  staffChange: { actor: WorkspaceActor; request: StaffRequest; id: string; preview: StaffPreview };
}

/** An agent's staff request: applied at once when its allowance covers it, else an approval card. */
export async function requestStaffChange(
  context: RuntimeContext,
  actor: ToolActor,
  input: unknown,
  key: string,
) {
  const request = parse(StaffRequestSchema, input);
  const who: WorkspaceActor = { agentId: actor.agentId, threadId: actor.threadId };
  const base = hash([actor.threadId, "staff", key]);
  const digest = hash(request);
  const id = request.kind === "add" ? `staff-${base.slice(0, 24)}` : request.threadId;
  const commandId = `staff:${base}`;
  const check = await context.privacy.prepareData(request);
  const before = context.store.lastSeq();
  let produced = false;
  const receipt = context.store.dispatch<Record<string, unknown>>(commandId, (state) => {
    check(state);
    produced = true;
    const at = new Date().toISOString();
    const ctx = { commandId, at, actor: { kind: "agent" as const, id: actor.agentId } };
    const plan = planStaffChange(state, who, request);
    if (!plan.reasons.length) {
      const applied = applyStaffChange(state, who, request, id, ctx);
      return { ...applied, result: { status: "done", ...applied.result, digest } };
    }
    const interactionId = `staff-approval-${base.slice(0, 32)}`;
    const text = describe(plan.preview);
    const offer = plan.preview.allowanceOffer;
    const requested = requestInteraction(
      state,
      {
        id: interactionId,
        agentId: actor.agentId,
        threadId: actor.threadId,
        type: "approval",
        title: title(plan.preview),
        context: {
          toolName: "company_work",
          markdown: text,
          toolInput: { staffChange: { actor: who, request, id, preview: plan.preview } },
        },
        items: [
          {
            id: STAFF_APPROVAL_ITEM,
            header: "Team",
            prompt: text,
            choices: [{ id: "allow_once" }, { id: "reject_once" }],
            ...(offer
              ? {
                  options: [
                    {
                      id: STAFF_ALLOWANCE_OPTION,
                      label: `Add up to ${offer.max} more like this without asking`,
                    },
                  ],
                  multi: true,
                }
              : {}),
          },
        ],
        chain: [{ kind: "agent", id: actor.agentId }],
        urgency: "background",
        nativeRef: HOST_WORKSPACE_REF,
      },
      `${interactionId}:item`,
      ctx,
    );
    return {
      events: requested.events,
      result: { status: "pending", interactionId, reasons: plan.reasons, digest },
    };
  });
  const result = receipt.result;
  if (!isDeepStrictEqual(result.digest, digest)) throw new Error("command_receipt_conflict");
  if (produced) context.publish(context.store.eventsSince(before));
  const { digest: _digest, ...visible } = result;
  return result.status === "pending"
    ? {
        ...visible,
        note: "The owner must approve this. The outcome arrives as a later message; end your turn.",
      }
    : visible;
}

function outcome(preview: StaffPreview, result: Record<string, unknown>) {
  if (preview.kind === "add")
    return `added ${preview.name} to ${preview.teamName || "the team"} as chat ${String(result.threadId)}`;
  if (preview.kind === "change") return `changed ${preview.name}`;
  return result.archived
    ? `archived ${preview.name}`
    : `${preview.name} will be archived once their running work finishes`;
}
/** Applies or declines a staff approval and tells the requesting chat through its input queue. */
export async function respondStaffApproval(
  context: RuntimeContext,
  request: Interaction,
  answer: InteractionAnswer,
) {
  if (answer.by.kind !== "human") throw new Error("human_answer_required");
  const stored = (request.context?.toolInput as Stored | undefined)?.staffChange;
  if (!stored) throw new Error("staff_request_missing");
  const approved = answer.action === "accept" && answer.choice === "allow_once";
  const grantAllowance =
    answer.answers?.[STAFF_APPROVAL_ITEM]?.options?.includes(STAFF_ALLOWANCE_OPTION) === true;
  const commandId = `staff-approval:${request.id}`;
  const queue = (
    state: Parameters<typeof queueHumanInput>[0],
    text: string,
    at: string,
    suffix: string,
  ) =>
    queueHumanInput(
      state,
      {
        threadId: request.threadId,
        input: [{ type: "text", text: `[Zoltbot] ${text}` }],
        mode: "queue",
        sourceInteractionId: request.id,
      },
      `${commandId}:${suffix}`,
      { commandId: `${commandId}:${suffix}`, at, actor: answer.by },
    );
  const before = context.store.lastSeq();
  try {
    context.store.dispatch(commandId, (state) => {
      const at = new Date().toISOString();
      if (!approved) {
        const why = answer.feedback?.trim() ? ` Reason: ${answer.feedback.trim()}` : "";
        return queue(state, `The owner declined: ${title(stored.preview)}.${why}`, at, "declined");
      }
      const applied = applyStaffChange(
        state,
        stored.actor,
        stored.request,
        stored.id,
        { commandId, at, actor: answer.by },
        { interactionId: request.id, grantAllowance },
      );
      const granted =
        grantAllowance && stored.preview.allowanceOffer
          ? ` You may add up to ${stored.preview.allowanceOffer.max} more like this without asking.`
          : "";
      const queued = queue(
        applyEvents(state, applied.events),
        `Approved: ${outcome(stored.preview, applied.result)}.${granted}`,
        at,
        "approved",
      );
      return {
        events: [...applied.events, ...queued.events].map((event, index) => ({
          ...event,
          eventId: `${commandId}:${index}`,
        })),
        result: applied.result,
      };
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : "staff_change_failed";
    const failed = `${commandId}:failed:${randomUUID()}`;
    context.store.dispatch(failed, (state) =>
      queue(
        state,
        `Approved, but the change could not be applied (${code.slice(0, 80)}).`,
        new Date().toISOString(),
        `failed:${failed.slice(-36)}`,
      ),
    );
  }
  context.publish(context.store.eventsSince(before));
  try {
    await context.wake(request.threadId);
  } catch {}
}

/** The owner's RPCs: apply a staff request directly, or set a manager's standing allowance. */
export function staffApi(context: RuntimeContext) {
  return async (method: string, params: Record<string, unknown>, commandId?: string) => {
    if (!(method in staffMethods)) return undefined;
    parse(staffMethods[method as keyof typeof staffMethods].params, params);
    if (!commandId) throw Error("command_id_required");
    const check = await context.privacy.prepareData(params);
    const before = context.store.lastSeq();
    const receipt = context.store.dispatch(commandId, (state) => {
      check(state);
      const ctx = {
        commandId,
        at: new Date().toISOString(),
        actor: { kind: "human" as const, id: "local-owner" },
      };
      if (method === "staff.allowance")
        return setStaffAllowance(state, params as Parameters<typeof setStaffAllowance>[1], ctx);
      const request = params.request as StaffRequest;
      const id =
        request.kind === "add"
          ? `staff-${hash(["owner", commandId]).slice(0, 24)}`
          : request.threadId;
      return applyStaffChange(state, undefined, request, id, ctx);
    });
    context.publish(context.store.eventsSince(before));
    return receipt.result;
  };
}
