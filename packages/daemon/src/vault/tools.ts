// V2: the agents' `vault` tool. An agent in a browser session lists the logins it may use and asks
// the daemon to type one into a page. The daemon checks the page is the saved site and the field
// is a password field, asks the owner the first time, then types the value itself: the agent
// never receives it, and nothing it can read (tool result, audit, log) contains it.
import { queueHumanInput, requestInteraction } from "@zoltbot/core";
import type { ToolActor, ToolInvocation } from "@zoltbot/hostmcp";
import {
  HOST_WORKSPACE_REF,
  type Interaction,
  type InteractionAnswer,
  vaultSiteMatches,
} from "@zoltbot/protocol";
import type { RuntimeContext } from "../api-types.js";
import { ownedBrowser } from "../browser/evidence.js";
import type { VaultRuntime } from "./api.js";
import { browserPageDriver, type PageDriver, validTarget } from "./page-driver.js";
import type { VaultRecord } from "./store.js";

export const vaultToolDefinition = {
  name: "vault",
  description:
    "Sign in with the owner's saved logins. list: logins you may use. fill: id plus snapshot refs of the password field (and username); Zoltbot types them, you never see the password.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: { type: "string", enum: ["list", "fill"] },
      id: { type: "string", maxLength: 100 },
      password: { type: "string", minLength: 1, maxLength: 500 },
      username: { type: "string", minLength: 1, maxLength: 500 },
      submit: { type: "boolean" },
    },
    required: ["action"],
    additionalProperties: false,
  },
};

export const vaultCompactSchema = {
  type: "object",
  properties: {
    action: { type: "string" },
    id: { type: "string" },
    password: { type: "string" },
    username: { type: "string" },
    submit: { type: "boolean" },
  },
  required: ["action"],
};

const USERNAME_TYPES = new Set(["text", "email", "tel"]);

function allowed(record: VaultRecord, agentId: string) {
  return record.agents === "all" || record.agents.includes(agentId);
}

/** Only https pages are filled; plain http is allowed for this Mac's own addresses. */
export function fillableHost(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
    return parsed.protocol === "https:" || (parsed.protocol === "http:" && local)
      ? parsed.hostname
      : undefined;
  } catch {
    return undefined;
  }
}

/** Each run may raise this many cards for one login before it has to stop asking. */
const MAX_CARDS = 20;

/**
 * Where the owner stands on this run using this login. "Allow once" covers one fill (its use is
 * recorded under a fixed audit id, so a restart can't replay it); "Allow for this chat" covers the
 * rest of the run. Returns the card to raise next when there is none waiting.
 */
function decision(context: RuntimeContext, actor: ToolActor, entryId: string, host: string) {
  const prefix = `vault-fill:${actor.sessionId}:${entryId}`;
  let count = 0;
  while (count < MAX_CARDS && context.store.record("interaction", `${prefix}:${count + 1}`))
    count++;
  const next = { state: "ask" as const, id: `${prefix}:${count + 1}` };
  if (!count) return next;
  const id = `${prefix}:${count}`;
  const card = context.store.record("interaction", id);
  const input = (card?.context as { toolName?: unknown; toolInput?: VaultCardInput } | undefined)
    ?.toolInput;
  // Only this tool's own card, for this login, agent and site, counts.
  const ours =
    (card?.context as { toolName?: unknown } | undefined)?.toolName === "vault" &&
    input?.vaultFill === entryId &&
    card?.agentId === actor.agentId;
  if (!ours) return { state: "declined" as const, id };
  // A card for another site of the same login asks again.
  if (input?.vaultHost !== host) return count < MAX_CARDS ? next : { state: "limit" as const, id };
  const answer = card?.resolution as InteractionAnswer | undefined;
  const accepted = answer?.by.kind === "human" && answer.action === "accept";
  if (accepted && answer.choice === "allow_session") return { state: "approved" as const, id };
  if (accepted && answer.choice === "allow_once")
    return context.store.record("audit", usedId(id))
      ? count < MAX_CARDS
        ? next
        : { state: "limit" as const, id }
      : { state: "approved" as const, id, once: true };
  if (answer || card?.state !== "pending") return { state: "declined" as const, id };
  return { state: "pending" as const, id };
}

const usedId = (cardId: string) => `vault-fill-used:${cardId}`;

interface VaultCardInput {
  vaultFill?: string;
  vaultHost?: string;
}

function askOwner(
  context: RuntimeContext,
  actor: ToolActor,
  id: string,
  record: VaultRecord,
  host: string,
) {
  const agent = context.store.record("agent", actor.agentId);
  const name = typeof agent?.name === "string" ? agent.name : "This agent";
  const before = context.store.lastSeq();
  context.store.dispatch(id, (state) =>
    requestInteraction(
      state,
      {
        id,
        agentId: actor.agentId,
        threadId: actor.threadId,
        type: "approval",
        title: `Sign in to ${host}`,
        context: {
          toolName: "vault",
          markdown: `Zoltbot types the password into the page. ${name} never sees it.`,
          toolInput: { vaultFill: record.id, vaultHost: host },
        },
        items: [
          {
            id: "vault",
            header: "Vault",
            prompt: `Let ${name} sign in to ${host} with your saved login?`,
            choices: [{ id: "allow_once" }, { id: "allow_session" }, { id: "reject_once" }],
          },
        ],
        chain: [{ kind: "agent", id: actor.agentId }],
        urgency: "background",
        nativeRef: HOST_WORKSPACE_REF,
      },
      `${id}:item`,
      { commandId: id, at: new Date().toISOString(), actor: { kind: "agent", id: actor.agentId } },
    ),
  );
  context.publish(context.store.eventsSince(before));
}

export function vaultTools(
  context: RuntimeContext,
  /** Tests pass a fake page; the default drives the run's own browser session. */
  options: { page?: (actor: ToolActor) => PageDriver } = {},
) {
  const pageFor =
    options.page ??
    ((actor: ToolActor) => browserPageDriver(ownedBrowser(context.store, actor).binding));
  const runtime = (): VaultRuntime | undefined =>
    context.vault?.available() ? context.vault : undefined;
  const filling = new Set<string>();

  async function fill(actor: ToolActor, args: Record<string, unknown>, vault: VaultRuntime) {
    const record = vault.records.get(String(args.id ?? ""));
    if (!record || !allowed(record, actor.agentId)) return { error: "vault_entry_not_found" };
    if (record.kind !== "login") return { error: "vault_entry_not_a_login" };
    const password = String(args.password ?? "");
    const username = typeof args.username === "string" ? args.username : undefined;
    if (!validTarget(password) || (username !== undefined && !validTarget(username)))
      return { error: "invalid_target" };
    if (username !== undefined && !record.username) return { error: "vault_entry_has_no_username" };
    const page = pageFor(actor);

    // The value only goes into a password field, on the saved site, in the frame it is in.
    const field = await page.field(password);
    const host = fillableHost(field.url);
    if (field.type !== "password") return { error: "not_a_password_field" };
    if (!host || !record.sites.some((site) => vaultSiteMatches(site, host)))
      return { error: "site_mismatch", sites: record.sites };
    if (username !== undefined) {
      const named = await page.field(username);
      if (!USERNAME_TYPES.has(named.type)) return { error: "not_a_username_field" };
      if (fillableHost(named.url) !== host) return { error: "site_mismatch", sites: record.sites };
    }

    const approval = decision(context, actor, record.id, host);
    if (approval.state === "declined") return { error: "owner_declined" };
    if (approval.state === "limit") return { error: "too_many_requests" };
    if (approval.state === "pending") return { status: "waiting_for_owner" };
    if (approval.state === "ask") {
      askOwner(context, actor, approval.id, record, host);
      return { status: "waiting_for_owner" };
    }

    // "Allow once" is used up before anything is read or typed, so a failure partway through
    // can't leave it to approve another fill.
    if ("once" in approval)
      vault.audit({
        id: usedId(approval.id),
        action: "vault.fill.approval_used",
        entryId: record.id,
        actor: { kind: "agent", id: actor.agentId },
        detail: { host, sessionId: actor.sessionId },
      });
    const value = await vault.read(record);
    if (value.kind !== "login") return { error: "vault_entry_not_a_login" };
    const fields = [
      ...(username !== undefined && record.username
        ? [{ target: username, value: record.username, types: [...USERNAME_TYPES] }]
        : []),
      { target: password, value: value.password, types: ["password"] },
    ];
    try {
      await page.fill(fields, new URL(field.url).origin, args.submit === true);
    } catch (error) {
      // The page moved on between the check and the fill; nothing was typed.
      if (error instanceof Error && error.message === "page_changed")
        return { error: "page_changed" };
      throw error;
    }
    const filled = fields.length === 2 ? ["username", "password"] : ["password"];
    await vault.markUsed(record.id);
    vault.audit({
      action: "vault.fill",
      entryId: record.id,
      actor: { kind: "agent", id: actor.agentId },
      detail: { host, sessionId: actor.sessionId, approval: approval.id },
    });
    return { filled, submitted: args.submit === true };
  }

  return {
    authorize(actor: ToolActor) {
      try {
        ownedBrowser(context.store, actor);
        return true;
      } catch {
        return false;
      }
    },
    async call(call: ToolInvocation): Promise<unknown> {
      const vault = runtime();
      if (!vault) return { error: "vault_not_set_up" };
      const args = (call.arguments ?? {}) as Record<string, unknown>;
      if (args.action === "list")
        return {
          logins: vault.records
            .list()
            .filter((record) => record.kind === "login" && allowed(record, call.actor.agentId))
            .map((record) => ({
              id: record.id,
              label: record.label,
              sites: record.sites,
              hasUsername: !!record.username,
            })),
        };
      if (args.action !== "fill") return { error: "unknown_action" };
      // One fill at a time per run, so two calls can't both raise the owner's prompt.
      if (filling.has(call.actor.sessionId)) return { error: "fill_in_progress" };
      filling.add(call.actor.sessionId);
      try {
        return await fill(call.actor, args, vault);
      } catch (error) {
        const code = error instanceof Error ? error.message : "";
        return {
          error: ["browser_unavailable", "browser_authority_denied"].includes(code)
            ? code
            : "fill_failed",
        };
      } finally {
        filling.delete(call.actor.sessionId);
      }
    },
  };
}

/** The owner's answer goes back to the agent, which is told to call fill again. */
export async function respondVaultApproval(
  context: RuntimeContext,
  request: Interaction,
  answer: InteractionAnswer,
) {
  if (answer.by.kind !== "human") throw Error("human_answer_required");
  const approved =
    answer.action === "accept" &&
    (answer.choice === "allow_once" || answer.choice === "allow_session");
  const id = `vault-answer:${request.id}`;
  const before = context.store.lastSeq();
  context.store.dispatch(id, (state) =>
    queueHumanInput(
      state,
      {
        threadId: request.threadId,
        input: [
          {
            type: "text",
            text: `[Zoltbot] Vault sign-in ${approved ? "approved; call vault fill again to continue" : "declined"}.`,
          },
        ],
        mode: "queue",
        sourceInteractionId: request.id,
      },
      `${id}:input`,
      { commandId: id, at: new Date().toISOString(), actor: answer.by },
    ),
  );
  context.publish(context.store.eventsSince(before));
  await context.wake(request.threadId);
}
