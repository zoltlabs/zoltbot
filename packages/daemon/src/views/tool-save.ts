import { randomUUID } from "node:crypto";
import { rename, rm } from "node:fs/promises";
import path from "node:path";
import { queueHumanInput, requestInteraction } from "@zoltbot/core";
import type { ToolActor, ToolInvocation } from "@zoltbot/hostmcp";
import {
  HOST_WORKSPACE_REF,
  type Interaction,
  type InteractionAnswer,
  parseEvent,
} from "@zoltbot/protocol";
import type { RuntimeContext } from "../api-types.js";
import { checkedAncestors, safeFile } from "../artifacts/intake.js";
import { exists } from "./files.js";
import { loadView, viewHash } from "./loader.js";
import { viewOrigin, viewOriginEvent } from "./origin.js";
import { viewActor } from "./tool-owner.js";
import type { ViewToolArgs } from "./tool-read.js";
import { stageView } from "./tool-stage.js";

interface Proposal {
  id: string;
  viewId: string;
  bundleHash: string;
  baseHash: string | null;
  actor: ToolActor;
  commandId: string;
  requestHash: string;
  requestId: string;
  changed: string[];
  state: "pending" | "applied" | "declined";
}
const proposalKey = (id: string) => `view.proposal.${id}`;
function proposalEvent(commandId: string, proposal: Proposal) {
  const key = proposalKey(proposal.id);
  return parseEvent({
    eventId: `${commandId}:proposal`,
    aggregateType: "settings",
    aggregateId: key,
    type: "settings.updated",
    occurredAt: new Date().toISOString(),
    payload: { key, value: proposal },
  });
}
function saveAudit(commandId: string, proposal: Proposal, confirmed: boolean) {
  const at = new Date().toISOString();
  return parseEvent({
    eventId: `${commandId}:audit`,
    aggregateType: "audit",
    aggregateId: `audit:${commandId}`,
    type: "audit.created",
    occurredAt: at,
    payload: {
      id: `audit:${commandId}`,
      actor: { kind: "agent", id: proposal.actor.agentId },
      action: "view.save",
      target: proposal.viewId,
      result: "allowed",
      detail: {
        confirmed,
        changed: proposal.changed,
        ...(confirmed ? { interactionId: proposal.requestId } : {}),
      },
      at,
    },
  });
}
async function applyProposal(context: RuntimeContext, proposal: Proposal, confirmed: boolean) {
  const { registry } = viewActor(context, proposal.actor, true, false);
  const id = proposal.viewId,
    folder = path.join(registry.user, `.view-stage-${proposal.id}`, id),
    root = path.dirname(folder);
  const candidate = await loadView(folder);
  if (candidate.bundleHash !== proposal.bundleHash) throw Error("view_proposal_changed");
  const old = context.store.record("view", id),
    base = old && registry.bundle(String(old.bundleHash));
  if (
    proposal.baseHash === null
      ? !!old
      : !base ||
        base.bundleHash !== proposal.baseHash ||
        (await loadView(base.directory, base.allowRootOwned)).bundleHash !== proposal.baseHash
  )
    throw Error("view_changed");
  const target = path.join(registry.user, id),
    present = await exists(target);
  if (present && old?.source !== "user") throw Error("view_changed");
  const texts: string[] = [];
  for (const file of candidate.files)
    if (/^(text\/|application\/json$|image\/svg\+xml$)/.test(file.mime))
      texts.push((await safeFile(folder, file.path)).toString("utf8"));
  const guard = await context.privacy.prepareData({ proposal, texts }),
    before = context.store.lastSeq();
  context.store.dispatch(`${proposal.commandId}:apply-consent`, (state) => {
    guard(state);
    return {
      events: [saveAudit(proposal.commandId, proposal, confirmed)],
      result: { bundleHash: proposal.bundleHash },
    };
  });
  context.publish(context.store.eventsSince(before));
  const parent = await checkedAncestors(registry.user),
    backup = path.join(registry.user, `.view-backup-${randomUUID()}`);
  let movedOld = false,
    movedNew = false,
    committed = false;
  try {
    if (present) {
      await rename(target, backup);
      movedOld = true;
    }
    if ((await checkedAncestors(registry.user)) !== parent) throw Error("view_directory_changed");
    await rename(folder, target);
    movedNew = true;
    await registry.refresh();
    const beforeDone = context.store.lastSeq();
    const next = { ...proposal, state: "applied" as const };
    context.store.dispatch(`${proposal.commandId}:applied`, (state) => {
      guard(state);
      return {
        events: [
          proposalEvent(`${proposal.commandId}:applied`, next),
          ...(!old ? [viewOriginEvent(proposal.commandId, id, proposal.actor.threadId)] : []),
        ],
        result: { id, bundleHash: candidate.bundleHash },
      };
    });
    committed = true;
    context.publish(context.store.eventsSince(beforeDone));
    if (movedOld) {
      await rm(backup, { recursive: true });
      movedOld = false;
    }
    await rm(root, { recursive: true, force: true });
    return { status: "saved", id, bundleHash: candidate.bundleHash, href: `#view/${id}` };
  } catch (error) {
    if (committed)
      return { status: "saved", id, bundleHash: candidate.bundleHash, href: `#view/${id}` };
    // Never replace somebody else's new folder when rolling back an incomplete save.
    if (movedNew) {
      const installed = await loadView(target).catch(() => undefined);
      if (installed?.bundleHash === proposal.bundleHash) {
        await rename(target, folder);
        movedNew = false;
      }
    }
    if (!movedNew && movedOld && !(await exists(target))) {
      await rename(backup, target);
    }
    if (!movedNew) await registry.refresh();
    throw error;
  }
}
export async function saveViewTool(context: RuntimeContext, call: ToolInvocation) {
  const { registry } = viewActor(context, call.actor, true),
    args = call.arguments as ViewToolArgs;
  const commandId = `view-save:${viewHash(JSON.stringify([call.actor, call.idempotencyKey, args.key]))}`,
    requestHash = viewHash(JSON.stringify(args));
  return registry.run(async () => {
    const replay = context.store.receipt<{ requestHash: string; value: unknown }>(commandId);
    if (replay) {
      if (replay.result.requestHash !== requestHash) throw Error("command_receipt_conflict");
      return replay.result.value;
    }
    const staged = await stageView(context, call, args);
    let retain = false;
    try {
      const id = staged.checked.manifest.id;
      const owned =
        context.store.record("view", id)?.source === "user" &&
        viewOrigin(context.store, id) === call.actor.threadId;
      const proposal: Proposal = {
        id: staged.proposalId,
        viewId: id,
        bundleHash: staged.checked.bundleHash,
        baseHash: staged.base?.bundleHash ?? null,
        actor: call.actor,
        commandId,
        requestHash,
        requestId: `view-edit-${staged.proposalId}`,
        changed: staged.changed,
        state: "pending",
      };
      const check = await context.privacy.prepareData(proposal),
        before = context.store.lastSeq();
      viewActor(context, call.actor, true);
      if (staged.base && staged.changed.length && !owned) {
        const markdown = `Files changed in ${id}:\n\n${staged.changed.map((name) => `- ${name.replace(/[\\`*_[\]<>!|()]/g, "\\$&")}`).join("\n")}`;
        const receipt = context.store.dispatch(commandId, (state) => {
          staged.guard(state);
          check(state);
          const requested = requestInteraction(
            state,
            {
              id: proposal.requestId,
              agentId: call.actor.agentId,
              threadId: call.actor.threadId,
              type: "approval",
              title: `Update ${staged.checked.manifest.name}`,
              context: {
                toolName: "team_view",
                markdown,
                toolInput: { viewProposal: proposal.id },
              },
              items: [
                {
                  id: "view",
                  prompt: "Apply these view file changes?",
                  choices: [{ id: "allow_once" }, { id: "reject_once" }],
                },
              ],
              chain: [{ kind: "agent", id: call.actor.agentId }],
              urgency: "background",
              nativeRef: HOST_WORKSPACE_REF,
            },
            `${proposal.requestId}:item`,
            {
              commandId,
              at: new Date().toISOString(),
              actor: { kind: "agent", id: call.actor.agentId },
            },
          );
          return {
            events: [...requested.events, proposalEvent(commandId, proposal)],
            result: {
              requestHash,
              value: {
                status: "pending",
                id,
                requestId: proposal.requestId,
                changedCount: staged.changed.length,
              },
            },
          };
        });
        retain = true;
        context.publish(context.store.eventsSince(before));
        return receipt.result.value;
      }
      const value = staged.changed.length
        ? await applyProposal(context, proposal, false)
        : { status: "unchanged", id, href: `#view/${id}` };
      return context.store.dispatch(commandId, () => ({
        events: [],
        result: { requestHash, value },
      })).result.value;
    } finally {
      if (!retain) await rm(staged.root, { recursive: true, force: true });
    }
  });
}
export async function respondViewApproval(
  context: RuntimeContext,
  request: Interaction,
  answer: InteractionAnswer,
) {
  if (answer.by.kind !== "human") throw Error("human_answer_required");
  const id = (request.context?.toolInput as { viewProposal?: string } | undefined)?.viewProposal;
  if (!id || !/^[a-f0-9-]{36}$/.test(id) || !context.views) throw Error("view_proposal_missing");
  const proposal = context.store.record("settings", proposalKey(id))?.value as Proposal | undefined;
  if (
    !proposal ||
    proposal.id !== id ||
    !/^[a-z0-9-]{2,40}$/.test(proposal.viewId) ||
    proposal.requestId !== request.id ||
    proposal.actor.threadId !== request.threadId ||
    proposal.actor.agentId !== request.agentId
  )
    throw Error("view_proposal_missing");
  const approved = answer.action === "accept" && answer.choice === "allow_once";
  let message: string;
  try {
    if (proposal.state === "applied") message = `View saved: #view/${proposal.viewId}`;
    else if (approved) {
      await context.views.run(() => applyProposal(context, proposal, true));
      message = `View saved: #view/${proposal.viewId}`;
    } else {
      const commandId = `${proposal.commandId}:declined`,
        before = context.store.lastSeq();
      context.store.dispatch(commandId, () => ({
        events: [proposalEvent(commandId, { ...proposal, state: "declined" })],
        result: {},
      }));
      context.publish(context.store.eventsSince(before));
      await rm(path.join(context.views.user, `.view-stage-${proposal.id}`), {
        recursive: true,
        force: true,
      });
      message = "The view edit was declined. Your staging files are still in your working folder.";
    }
  } catch {
    message =
      "The approved view edit could not be applied. Read the current bundle and propose the changes again.";
  }
  const commandId = `view-reply:${request.id}`,
    check = await context.privacy.prepareData(message),
    before = context.store.lastSeq();
  context.store.dispatch(commandId, (state) => {
    check(state);
    return queueHumanInput(
      state,
      {
        threadId: request.threadId,
        input: [{ type: "text", text: `[Zoltbot] ${message}` }],
        mode: "queue",
        sourceInteractionId: request.id,
      },
      `${commandId}:item`,
      { commandId, at: new Date().toISOString(), actor: answer.by },
    );
  });
  context.publish(context.store.eventsSince(before));
  try {
    await context.wake(request.threadId);
  } catch {}
}
