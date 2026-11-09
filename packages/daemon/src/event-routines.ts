import { createHash } from "node:crypto";
import {
  admitRoutineEvent,
  archiveEventHistory,
  type CommandContext,
  type DomainState,
  dispatchWaitingEvent,
  EVENT_OFFLINE_POLICY,
  eventBrief,
  eventCapacity,
  eventEligibility,
  eventGeneration,
  eventRoutine,
  handle,
  matchRoutineEvent,
  type Outcome,
  prepareEventRoutine,
  routineEvent,
} from "@zoltbot/core";
import {
  type ActorRef,
  type EventRoutineInput,
  parse,
  type Routine,
  RoutineOccurrenceSchema,
  RoutineSchema,
  RoutineSourceEventSchema,
} from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import { type GitHubTransport, ghTransport } from "../../github/src/transport.js";
import { routineHumanAuthorization } from "./event-routine-authorization.js";
import { type EventIdentity, type EventSourceAdapter, githubEventSource } from "./event-sources.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 24);
const human = { kind: "human" as const, id: "local-owner" };
type Run = (id: string, work: (state: DomainState, context: CommandContext) => Outcome) => unknown;
const methods = new Set([
  "routine.archiveHistory",
  "routine.retrySource",
  "routine.runOnce",
  "routine.checkSource",
  "routine.connectionHandoff",
  "routine.prepare",
  "routine.editEvent",
  "routine.preview",
  "routine.commit",
  "routine.enable",
  "routine.pause",
]);
export function eventRoutines(options: {
  store: Store;
  run: Run;
  now(): string;
  transport?: GitHubTransport;
  adapters?: EventSourceAdapter[];
  actor?: ActorRef;
  chatId?: string;
  humanMessageId?: string;
  checkPublic?(value: unknown): Promise<(state: DomainState) => void>;
}) {
  const { store, run } = options;
  const baseTransport = options.transport ?? ghTransport;
  let pollDeadline: number | undefined;
  const transport: GitHubTransport = (endpoint, method, body, signal) => {
    const remaining = pollDeadline ? pollDeadline - Date.now() : 30_000;
    if (remaining <= 0) return Promise.reject(new Error("github_poll_time_limit"));
    return baseTransport(endpoint, method, body, signal ?? AbortSignal.timeout(remaining));
  };
  const healthKey = (id: string) => `routine.event.health.${id}`;
  const adapters = [...(options.adapters ?? []), githubEventSource(transport)];
  const adapterFor = (routine: Routine) => {
    const adapter = adapters.find((value) => value.supports(routine.event?.source.kind ?? ""));
    if (!adapter) throw new Error("event_delivery_setup_unavailable_open_connections");
    return adapter;
  };
  function health(id: string, value: Record<string, unknown>) {
    run(`event-health:${id}:${hash(JSON.stringify(value))}`, (state, context) =>
      handle(
        state,
        {
          type: state.settings?.some((row) => row.key === healthKey(id)) ? "update" : "create",
          kind: "settings",
          id: healthKey(id),
          changes: { value },
          value: { key: healthKey(id), value },
        } as Parameters<typeof handle>[1],
        context,
      ),
    );
  }
  return {
    async launchCheck(task: Record<string, unknown>) {
      const occurrence = store.record("routineOccurrence", String(task.routineOccurrenceId));
      if (!occurrence?.sourceEvent) return;
      const routine = eventRoutine(store.snapshot(), String(occurrence.routineId));
      if (
        (!occurrence.manual && routine.paused) ||
        eventGeneration(routine) !== (occurrence.generation ?? occurrence.routineRevision)
      )
        throw new Error("event_routine_paused_or_changed");
      eventEligibility(store.snapshot(), routine, true);
      const event = parse(RoutineSourceEventSchema, occurrence.sourceEvent);
      if (
        Date.parse(options.now()) >
        (occurrence.expiresAt
          ? Date.parse(String(occurrence.expiresAt))
          : Date.parse(event.occurredAt) + 15 * 60_000)
      )
        throw new Error("event_expired_before_launch");
      await adapterFor(routine).validate(routine, event);
    },
    handles: (method: string) => methods.has(method),
    async api(
      method: string,
      params: Record<string, unknown>,
      commandId: string,
      check?: (state: DomainState) => void,
    ) {
      if (!methods.has(method)) return undefined;
      if (
        options.actor?.kind === "agent" &&
        !(
          options.humanMessageId &&
          ["routine.commit", "routine.enable", "routine.runOnce"].includes(method)
        ) &&
        ![
          "routine.prepare",
          "routine.editEvent",
          "routine.preview",
          "routine.pause",
          "routine.checkSource",
        ].includes(method)
      )
        throw new Error("human_routine_required");
      if (!commandId) throw new Error("command_id_required");
      const receipt = store.receipt(commandId);
      const canonical = (value: unknown): unknown =>
        Array.isArray(value)
          ? value.map(canonical)
          : value && typeof value === "object"
            ? Object.fromEntries(
                Object.entries(value)
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([key, item]) => [key, canonical(item)]),
              )
            : value;
      const commandDigest = hash(JSON.stringify(canonical({ method, params })));
      if (
        receipt &&
        [
          "routine.connectionHandoff",
          "routine.archiveHistory",
          "routine.retrySource",
          "routine.runOnce",
        ].includes(method)
      ) {
        if ((receipt.result as { commandDigest?: string }).commandDigest !== commandDigest)
          throw new Error("command_receipt_conflict");
        return receipt.result;
      }
      if (receipt) {
        const result = receipt.result as Record<string, unknown>;
        const routine = (result.routine ?? result) as Routine;
        if (routine.event?.commandDigest !== commandDigest)
          throw new Error("command_receipt_conflict");
        return receipt.result;
      }
      let verified: EventIdentity | undefined;
      if (method === "routine.enable" || method === "routine.checkSource") {
        const r = eventRoutine(store.snapshot(), String(params.id), Number(params.revision));
        eventEligibility(store.snapshot(), r, method === "routine.enable");
        if (
          method === "routine.enable" &&
          (r.event?.phase !== "saved" || r.event.previewRevision !== r.event.revision)
        )
          throw new Error("preview_and_save_required");
        const adapter = adapterFor(r);
        if (method === "routine.enable" && !r.event.accountId)
          throw new Error("github_account_review_required");
        verified = await adapter.verify(r.event.source);
        if (
          method === "routine.enable" &&
          (r.event.repositoryId !== verified.repositoryId ||
            (r.event.sourceMode && r.event.sourceMode !== verified.sourceMode))
        )
          throw new Error("event_source_identity_changed");
        if (r.event.accountId && r.event.accountId !== verified.accountId)
          throw new Error("github_account_changed_review_required");
      }
      let replay: import("@zoltbot/protocol").RoutineSourceEvent | undefined;
      if (method === "routine.runOnce") {
        const routine = eventRoutine(store.snapshot(), String(params.id), Number(params.revision));
        const prior = parse(
          RoutineOccurrenceSchema,
          store.record("routineOccurrence", String(params.occurrenceId)),
        );
        if (prior.routineId !== routine.id || !prior.sourceEvent || prior.archivedAt)
          throw new Error("event_replay_source_unavailable");
        await adapterFor(routine).validate(routine, prior.sourceEvent);
        replay = {
          ...prior.sourceEvent,
          key: `replay-${hash(commandId)}`,
          receivedAt: options.now(),
        };
      }
      return run(commandId, (state, ctx) => {
        check?.(state);
        const context = { ...ctx, actor: options.actor ?? human };
        if (method === "routine.prepare") {
          const draft = prepareEventRoutine(
            state,
            params as EventRoutineInput,
            `event-${hash(commandId)}`,
            context,
            options.chatId,
          ).result as Routine;
          const next = { ...draft, event: { ...draft.event!, commandDigest } };
          return { events: [routineEvent("routine", next, context)], result: next };
        }
        const old = eventRoutine(state, String(params.id), Number(params.revision));
        const config = old.event!;
        const grant =
          options.actor?.kind === "agent" &&
          ["routine.commit", "routine.enable", "routine.runOnce"].includes(method)
            ? routineHumanAuthorization(
                state,
                options.chatId!,
                options.humanMessageId!,
                old,
                method,
                String(params.occurrenceId ?? ""),
              )
            : undefined;
        const grantEvents = grant
          ? handle(
              state,
              { type: "create", kind: "settings", value: grant },
              { ...context, commandId: `${context.commandId}:authorization` },
            ).events
          : [];
        if (method === "routine.runOnce" && replay) {
          const outcome = admitRoutineEvent(
            state,
            old.id,
            replay,
            { ...ctx, actor: { kind: "system", id: "event-replay" } },
            { manual: true, replayOf: String(params.occurrenceId) },
          );
          return {
            ...outcome,
            events: [...outcome.events, ...grantEvents],
            result: { ...outcome.result, commandDigest },
          };
        }
        if (method === "routine.archiveHistory") {
          const outcome = archiveEventHistory(state, old.id, String(params.before), context);
          return {
            ...outcome,
            events: [...outcome.events, ...grantEvents],
            result: { ...outcome.result, commandDigest },
          };
        }
        if (method === "routine.retrySource") {
          const key = healthKey(old.id);
          const previous = state.settings?.find((row) => row.key === key)?.value as
            | Record<string, unknown>
            | undefined;
          const outcome = handle(
            state,
            previous
              ? {
                  type: "update",
                  kind: "settings",
                  id: key,
                  changes: {
                    value: { ...previous, nextCheckAt: context.at, drainNextCheckAt: context.at },
                  },
                }
              : {
                  type: "create",
                  kind: "settings",
                  value: { key, value: { nextCheckAt: context.at, drainNextCheckAt: context.at } },
                },
            context,
          );
          return { ...outcome, result: { commandDigest, retryScheduled: true } };
        }

        if (method === "routine.connectionHandoff") {
          const reference = `routine.handoff.${hash(commandId)}`;
          const value = {
            reference,
            commandDigest,
            routineId: old.id,
            revision: config.revision,
            owner: human.id,
            node: old.template.node,
            ...(config.chatId || options.chatId ? { chatId: config.chatId ?? options.chatId } : {}),
            createdAt: context.at,
          };
          return {
            ...handle(
              state,
              { type: "create", kind: "settings", value: { key: reference, value } },
              context,
            ),
            result: value,
          };
        }
        let next: Routine = old;
        if (method === "routine.checkSource") {
          if (!verified) throw new Error("github_identity_unverified");
          const { previewRevision: _preview, ...base } = config;
          next = {
            ...old,
            paused: true,
            event: {
              ...base,
              ...verified,
              revision: config.revision + 1,
              generation: (config.generation ?? config.revision) + 1,
            },
          };
        } else if (method === "routine.editEvent") {
          const prepared = prepareEventRoutine(
            { ...state, routine: [] },
            params.input as EventRoutineInput,
            old.id,
            context,
          ).result;
          next = parse(RoutineSchema, {
            ...prepared,
            createdAt: old.createdAt,
            event: {
              ...(prepared.event as object),
              revision: config.revision + 1,
              generation: (config.generation ?? config.revision) + 1,
              ...(config.chatId || options.chatId
                ? { chatId: config.chatId ?? options.chatId }
                : {}),
            },
          });
        } else if (method === "routine.preview") {
          eventEligibility(state, old);
          next = { ...old, event: { ...config, previewRevision: config.revision } };
        } else if (method === "routine.commit") {
          if (config.previewRevision !== config.revision) throw new Error("preview_required");
          next = {
            ...old,
            paused: true,
            event: { ...config, phase: "saved", authorizedBy: human.id },
          };
        } else if (method === "routine.enable") {
          eventEligibility(state, old, true);
          if (!verified || config.phase !== "saved" || config.previewRevision !== config.revision)
            throw new Error("preview_and_save_required");
          next = {
            ...old,
            paused: false,
            event: { ...config, ...verified, authorizedBy: human.id, enabledAt: context.at },
          };
        } else if (method === "routine.pause") next = { ...old, paused: true };
        if (["routine.commit", "routine.enable", "routine.pause"].includes(method)) {
          next = {
            ...next,
            event: {
              ...next.event!,
              revision: config.revision + 1,
              ...(config.previewRevision === config.revision
                ? { previewRevision: config.revision + 1 }
                : {}),
            },
          };
        }
        next = { ...next, event: { ...next.event!, commandDigest }, updatedAt: context.at };
        const sample = parse(RoutineSourceEventSchema, {
          normalizerVersion: 1,
          digest: "0".repeat(64),
          key: "synthetic-preview",
          kind: config.source.kind,
          resource: config.source.resource,
          accountId: config.accountId ?? "synthetic",
          resourceId: config.repositoryId ?? "synthetic",
          occurredAt: context.at,
          receivedAt: context.at,
          sha: "0".repeat(40),
          branch: config.source.branch ?? "main",
          workflowId: config.source.workflowId ?? "1",
          runId: "1",
          attempt: 1,
          reviewerId: config.accountId ?? "synthetic",
          ...(config.source.reviewTeamId ? { reviewTeamId: config.source.reviewTeamId } : {}),
        });
        const result =
          method === "routine.preview"
            ? {
                routine: next,
                ...(config.source.kind.startsWith("github.")
                  ? { sample, frozenBrief: eventBrief(next, sample) }
                  : {}),
                matches:
                  config.source.kind.startsWith("github.") && !matchRoutineEvent(next, sample),
                synthetic: true,
                taskStarted: false,
                explanation: config.source.kind.startsWith("github.")
                  ? "Synthetic matching example only. No provider delivery or agent execution verified."
                  : "Setup preview only. This source has no supported event delivery or normalizer yet; the draft remains paused.",
                task: {
                  title: next.template.title,
                  brief: next.template.brief,
                  permission: "read_only",
                  reviewRequired: true,
                },
                limits: `1 active run per routine, 2 event runs per Mac, ${config.dailyLimit} runs per UTC day, 50 per workspace. Busy events wait up to 15 minutes.`,
                offlinePolicy: EVENT_OFFLINE_POLICY,
                setup: config.source.kind.startsWith("github.")
                  ? "Enable verifies the current gh account and repository. Uses existing GitHub shipping sign-in; this does not connect MCP tools."
                  : "Agent tools and event delivery need separate setup in Connections. Event delivery is not yet supported for this source.",
              }
            : next;
        return { events: [routineEvent("routine", next, context), ...grantEvents], result };
      });
    },
    async tick() {
      const now = options.now();
      pollDeadline = Date.now() + 10_000;
      // Drain oldest waiting work before polling; one existing scheduler owns dispatch.
      for (const row of (store.snapshot(["routineOccurrence"]).routineOccurrence ?? [])
        .filter((row) => row.status === "waiting")
        .sort(
          (a, b) =>
            String(a.createdAt).localeCompare(String(b.createdAt)) ||
            String(a.id).localeCompare(String(b.id)),
        )) {
        if (Date.now() >= pollDeadline) break;
        const routine = eventRoutine(store.snapshot(), String(row.routineId));
        try {
          const expired =
            Date.parse(String(row.expiresAt)) <= Date.parse(now) ||
            eventGeneration(routine) !== (row.generation ?? row.routineRevision);
          if (!expired) {
            if ((routine.paused && !row.manual) || eventCapacity(store.snapshot(), routine, now))
              continue;
            const previous = store.record("settings", healthKey(routine.id))?.value as
              | Record<string, unknown>
              | undefined;
            if (previous?.drainNextCheckAt && String(previous.drainNextCheckAt) > now) continue;
            await adapterFor(routine).validate(
              routine,
              parse(RoutineSourceEventSchema, row.sourceEvent),
            );
          }
          run(`event-drain:${hash(String(row.id))}:${now}`, (state, ctx) =>
            dispatchWaitingEvent(state, String(row.id), ctx),
          );
        } catch (error) {
          const reason = safeError(error);
          if (["github_run_superseded", "github_review_superseded"].includes(reason)) {
            run(`event-superseded:${hash(String(row.id))}`, (state, ctx) => {
              const current = parse(
                RoutineOccurrenceSchema,
                state.routineOccurrence?.find((item) => item.id === row.id),
              );
              return {
                events: [
                  routineEvent(
                    "routineOccurrence",
                    { ...current, status: "expired", reason, updatedAt: now },
                    ctx,
                  ),
                ],
                result: current,
              };
            });
          } else {
            const previous = store.record("settings", healthKey(routine.id))?.value as
              | Record<string, unknown>
              | undefined;
            const retry =
              error && typeof error === "object" && "retryAfterMs" in error
                ? Number(error.retryAfterMs)
                : 0;
            health(routine.id, {
              ...previous,
              checkedAt: now,
              drainNextCheckAt: new Date(
                Date.parse(now) + Math.min(86400000, Math.max(120000, retry)),
              ).toISOString(),
              state: "needs_attention",
              reason,
              completeness: "unknown",
            });
          }
        }
      }
      try {
        const routines = (store.snapshot(["routine"]).routine ?? [])
          .map((row) => parse(RoutineSchema, row))
          .filter((r) => r.event && !r.paused)
          .sort((a, b) =>
            String(
              (store.record("settings", healthKey(a.id))?.value as { checkedAt?: string })
                ?.checkedAt ?? "",
            ).localeCompare(
              String(
                (store.record("settings", healthKey(b.id))?.value as { checkedAt?: string })
                  ?.checkedAt ?? "",
              ),
            ),
          );
        for (const routine of routines) {
          if (Date.now() >= pollDeadline) break;
          const previous = store.record("settings", healthKey(routine.id))?.value as
            | Record<string, unknown>
            | undefined;
          if (previous?.nextCheckAt && String(previous.nextCheckAt) > now) continue;
          try {
            eventEligibility(store.snapshot(), routine, true);
            const scan = await adapterFor(routine).scan(routine, now);
            for (const invalid of scan.quarantined) {
              const id = `${routine.id}@quarantine-${hash(invalid.key)}`;
              run(`event-quarantine:${hash(id)}:${now}`, (state, ctx) => {
                const old = state.routineOccurrence?.find((row) => row.id === id);
                if (
                  !old &&
                  ((state.routineOccurrence ?? []).filter(
                    (row) => row.routineId === routine.id && !row.archivedAt,
                  ).length >= 1000 ||
                    (state.routineOccurrence ?? []).filter(
                      (row) => row.eventMeta && !row.archivedAt,
                    ).length >= 10000)
                )
                  throw new Error("event_inbox_full_archive_history");
                const value = parse(RoutineOccurrenceSchema, {
                  ...old,
                  id,
                  routineId: routine.id,
                  scheduledAt: old?.scheduledAt ?? now,
                  status: "quarantined",
                  eventMeta: {
                    key: invalid.key,
                    digest: invalid.digest,
                    kind: routine.event!.source.kind,
                  },
                  reason: invalid.reason,
                  notify: "actionable_only",
                  duplicates: Number(old?.duplicates ?? -1) + 1,
                  createdAt: old?.createdAt ?? now,
                  updatedAt: now,
                });
                return { events: [routineEvent("routineOccurrence", value, ctx)], result: value };
              });
            }
            for (const event of scan.events) {
              const check = await options.checkPublic?.(event);
              run(`event-admit:${hash(`${routine.id}:${event.key}`)}:${now}`, (state, ctx) => {
                check?.(state);
                return admitRoutineEvent(state, routine.id, event, ctx);
              });
            }
            health(routine.id, {
              ...(previous?.drainNextCheckAt
                ? { drainNextCheckAt: previous.drainNextCheckAt }
                : {}),
              checkedAt: now,
              nextCheckAt: new Date(Date.parse(now) + 60_000).toISOString(),
              failures: 0,
              state: scan.quarantined.length ? "quarantined" : "polling",
              completeness: "unknown",
              policy: EVENT_OFFLINE_POLICY,
              cursor: scan.cursor,
              windowLimit: 20,
              possibleGap:
                scan.gap ||
                (!!previous && Date.parse(now) - Date.parse(String(previous.checkedAt)) > 120_000),
            });
            run(`event-retain:${routine.id}:${now.slice(0, 10)}`, (state, ctx) =>
              archiveEventHistory(
                state,
                routine.id,
                new Date(Date.parse(now) - 7 * 86400_000).toISOString(),
                ctx,
              ),
            );
          } catch (error) {
            const failures = Math.min(Number(previous?.failures ?? 0) + 1, 8);
            const retryAfter =
              error && typeof error === "object" && "retryAfterMs" in error
                ? Number(error.retryAfterMs)
                : 0;
            const jitter =
              Number.parseInt(hash(`${routine.id}:${failures}`).slice(0, 4), 16) % 15000;
            const delay = Math.max(retryAfter, Math.min(3600000, 60_000 * 2 ** failures + jitter));
            health(routine.id, {
              ...previous,
              checkedAt: now,
              state: "needs_attention",
              reason: safeError(error),
              failures,
              nextCheckAt: new Date(Date.parse(now) + Math.min(86400000, delay)).toISOString(),
              completeness: "unknown",
            });
          }
        }
      } finally {
        pollDeadline = undefined;
      }
    },
  };
}
function safeError(error: unknown) {
  return error instanceof Error && /^(github_|event_)[a-z_]+$/.test(error.message)
    ? error.message
    : "event_source_unavailable";
}
