import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  decideApproval,
  destructiveOperation,
  tokenizeCommand,
} from "@zoltbot/core/approval-rules";
import { type CommandContext, handle, type Outcome } from "@zoltbot/core/commands";
import { ApprovalRuleSchema, type DomainEvent, parse, RuleDraftSchema } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import type { PublicWriteCheck } from "./private-input.js";

function publicMatcher(rule: { matcher: Record<string, unknown> }): Record<string, unknown> {
  const fields = structuredClone(rule.matcher);
  delete fields.kind;
  return fields;
}

function replayRule(
  store: Store,
  method: string,
  params: Record<string, unknown>,
  commandId: string,
): unknown {
  const receipt = store.receipt<Record<string, unknown>>(commandId);
  if (!receipt) return undefined;
  const conflict = () => {
    throw new Error("command_receipt_conflict");
  };
  if (receipt.fromSeq < 1 || receipt.toSeq < receipt.fromSeq) return conflict();
  const events = store
    .eventsSince(receipt.fromSeq - 1, receipt.toSeq - receipt.fromSeq + 1)
    .filter((event) => event.commandId === commandId && event.aggregateType === "rule");
  if (method === "rule.create") {
    try {
      const rule = parse(ApprovalRuleSchema, receipt.result);
      const stored: Record<string, unknown> = { ...rule };
      for (const key of ["id", "createdBy", "createdAt", "revokedAt"]) delete stored[key];
      if (
        params.confirmed !== true ||
        !isDeepStrictEqual(stored, parse(RuleDraftSchema, params.rule)) ||
        !events.some((event) => event.type === "rule.created" && event.aggregateId === rule.id)
      )
        return conflict();
      return rule;
    } catch {
      return conflict();
    }
  }
  if (
    receipt.result.ok !== true ||
    receipt.result.id !== params.id ||
    !events.some(
      (event) =>
        event.type === "rule.updated" &&
        event.aggregateId === params.id &&
        typeof (event.payload as Record<string, unknown>).revokedAt === "string",
    )
  )
    return conflict();
  return { ok: true };
}

export function ruleApi(host: {
  store: Store;
  publish(events: DomainEvent[]): void;
  now?: () => string;
  checkPublic?(value: unknown): Promise<PublicWriteCheck>;
}) {
  const execute = (
    method: string,
    params: Record<string, unknown>,
    commandId?: string,
    check?: PublicWriteCheck,
  ): unknown => {
    if (!["rule.list", "rule.create", "rule.revoke", "rule.test"].includes(method))
      return undefined;
    const context: CommandContext = {
      commandId: commandId ?? "read",
      at: host.now?.() ?? new Date().toISOString(),
      actor: { kind: "human", id: "local-owner" },
    };
    const state = host.store.snapshot();
    if (method === "rule.list") {
      const limit = params.limit ?? 50;
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 200)
        throw new Error("invalid_rule_page_size");
      if (
        params.scope !== undefined &&
        !["global", "project", "agent"].includes(String(params.scope))
      )
        throw new Error("invalid_rule_scope_filter");
      if (
        params.state !== undefined &&
        !["active", "inactive", "all"].includes(String(params.state))
      )
        throw new Error("invalid_rule_state_filter");
      const rows = (state.rule ?? [])
        .filter(
          (rule) =>
            !(params.agentId && rule.scope === "agent" && rule.scopeId !== params.agentId) &&
            !(params.projectId && rule.scope === "project" && rule.scopeId !== params.projectId),
        )
        .filter((rule) => !params.scope || rule.scope === params.scope)
        .filter((rule) => {
          const active =
            !rule.revokedAt &&
            (!rule.expiresAt || Date.parse(String(rule.expiresAt)) > Date.parse(context.at));
          return (
            !params.state ||
            params.state === "all" ||
            (params.state === "active" ? active : !active)
          );
        })
        .sort((a, b) => String(a.id).localeCompare(String(b.id)));
      const stamp = createHash("sha256")
        .update(
          JSON.stringify([
            params.agentId ?? null,
            params.projectId ?? null,
            params.scope ?? null,
            params.state ?? null,
            rows,
          ]),
        )
        .digest("hex")
        .slice(0, 16);
      let offset = 0;
      if (params.cursor !== undefined) {
        const match = /^r2:(\d{1,9}):([a-f0-9]{16})$/.exec(String(params.cursor));
        if (!match || match[2] !== stamp || Number(match[1]) > rows.length)
          throw new Error("rule_cursor_stale");
        offset = Number(match[1]);
      }
      return {
        items: rows.slice(offset, offset + limit),
        ...(offset + limit < rows.length ? { cursor: `r2:${offset + limit}:${stamp}` } : {}),
      };
    }
    if (method === "rule.test") {
      check?.(state);
      if (typeof params.command !== "string" || !params.command || params.command.length > 16000)
        throw new Error("invalid_rule_command");
      for (const [key, kind] of [
        ["agentId", "agent"],
        ["projectId", "project"],
      ] as const)
        if (
          params[key] !== undefined &&
          !state[kind]?.some((row) => row.id === params[key] && !row.archived)
        )
          throw new Error("rule_scope_unavailable");
      const operation = {
        tool: typeof params.tool === "string" ? params.tool : "execute",
        kind: "execute" as const,
        agentId: typeof params.agentId === "string" ? params.agentId : "__rule_preview__",
        ...(typeof params.projectId === "string" ? { projectId: params.projectId } : {}),
        command: params.command,
      };
      const rule = decideApproval(
        (state.rule ?? []).map((row) => parse(ApprovalRuleSchema, row)),
        operation,
        context.at,
      );
      return {
        decision: rule?.decision ?? "ask",
        ...(rule ? { ruleId: rule.id } : {}),
        reason: rule
          ? "matched"
          : tokenizeCommand(params.command)
            ? "no_rule"
            : "unsupported_command",
        destructive: destructiveOperation(operation),
      };
    }

    if (!commandId) throw new Error("command_id_required");
    const replay = replayRule(host.store, method, params, commandId);
    if (replay !== undefined) return replay;
    let produce: (state: ReturnType<Store["snapshot"]>) => Outcome;
    if (method === "rule.create") {
      if (params.confirmed !== true) throw new Error("confirmation_required");
      const draft = parse(RuleDraftSchema, params.rule);
      if (draft.scope === "global" ? draft.scopeId !== undefined : !draft.scopeId)
        throw new Error("rule_scope_required");
      if (
        draft.scope !== "global" &&
        !state[draft.scope]?.some((row) => row.id === draft.scopeId && !row.archived)
      )
        throw new Error("rule_scope_unavailable");
      if (
        draft.expiresAt &&
        (!Number.isFinite(Date.parse(draft.expiresAt)) ||
          Date.parse(draft.expiresAt) <= Date.parse(context.at))
      )
        throw new Error("invalid_rule_expiry");
      const prefix = draft.matcher.command?.prefix;
      if (prefix) {
        const quoted = prefix.map((arg) => JSON.stringify(arg)).join(" ");
        const parsed = tokenizeCommand(quoted);
        if (
          prefix.length > 256 ||
          prefix.some((arg) => arg.length > 512) ||
          !parsed ||
          JSON.stringify(parsed) !== JSON.stringify(prefix)
        )
          throw new Error("invalid_rule_prefix");
        if (
          draft.decision === "allow" &&
          destructiveOperation({
            tool: draft.matcher.tool,
            kind: "execute",
            agentId: "owner",
            command: quoted,
          })
        )
          throw new Error("destructive_rule_forbidden");
      }
      if (
        draft.matcher.paths &&
        (draft.matcher.paths.length > 100 ||
          draft.matcher.paths.some((value) => value.length > 512))
      )
        throw new Error("invalid_rule_paths");
      const rule = { ...draft, id: randomUUID(), createdBy: context.actor, createdAt: context.at };
      produce = (state) =>
        handle(state, { type: "create", kind: "rule", value: rule, confirmed: true }, context);
    } else {
      const id = String(params.id);
      produce = (state) => {
        const outcome = handle(
          state,
          { type: "update", kind: "rule", id, changes: { revokedAt: context.at }, confirmed: true },
          context,
        );
        return { ...outcome, result: { ok: true, id } };
      };
    }
    let produced = false;
    const before = host.store.lastSeq();
    host.store.dispatch(commandId, (state) => {
      produced = true;
      check?.(state);
      return produce(state);
    });
    if (produced) host.publish(host.store.eventsSince(before));
    return replayRule(host.store, method, params, commandId);
  };
  return (method: string, params: Record<string, unknown>, commandId?: string): unknown => {
    if (!["rule.list", "rule.create", "rule.revoke", "rule.test"].includes(method))
      return undefined;
    const stable = structuredClone(params);
    if (!host.checkPublic || method === "rule.revoke") return execute(method, stable, commandId);
    if (method === "rule.list") {
      const result = execute(method, stable, commandId);
      return host
        .checkPublic(
          (result as { items: Record<string, unknown>[] }).items.map((row) =>
            publicMatcher(parse(ApprovalRuleSchema, row)),
          ),
        )
        .then((check) => {
          check(host.store.snapshot());
          return result;
        });
    }
    if (method === "rule.create") {
      if (!commandId) throw new Error("command_id_required");
      const replay = replayRule(host.store, method, stable, commandId);
      if (replay !== undefined) return replay;
    }
    return host
      .checkPublic(
        method === "rule.create"
          ? publicMatcher(parse(RuleDraftSchema, stable.rule))
          : { command: stable.command, tool: stable.tool ?? "execute" },
      )
      .then((check) => execute(method, stable, commandId, check));
  };
}
