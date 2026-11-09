import { parse, RoutineSourceEventSchema } from "@zoltbot/protocol";
import { type EventSourceAdapter, eventHash, eventRecord } from "./event-sources.js";

/** Test-only delivery contract. A tools login alone cannot assert event delivery authority. */
export function mockSentryEventSource(
  read: (tool: string, args: Record<string, unknown>) => Promise<unknown>,
): EventSourceAdapter {
  async function verify(source: Parameters<EventSourceAdapter["verify"]>[0]) {
    const identity = eventRecord(
      await read("sentry_fixture_identity", { resource: source.resource }),
    );
    if (
      identity.mock !== true ||
      identity.eventDelivery !== true ||
      identity.resource !== source.resource ||
      typeof identity.accountId !== "string" ||
      typeof identity.projectId !== "string"
    )
      throw new Error("event_delivery_setup_unavailable_open_connections");
    return {
      accountId: identity.accountId,
      accountLabel: "Mock Sentry fixture",
      repositoryId: identity.projectId,
      sourceMode: "mock" as const,
    };
  }
  async function bound(routine: Parameters<EventSourceAdapter["scan"]>[0]) {
    const identity = await verify(routine.event!.source);
    if (
      routine.event?.sourceMode !== "mock" ||
      identity.accountId !== routine.event.accountId ||
      identity.repositoryId !== routine.event.repositoryId
    )
      throw new Error("event_source_identity_changed");
    return identity;
  }
  return {
    supports: (kind) => kind === "sentry.issue_created",
    verify,
    async validate(routine, event) {
      await bound(routine);
      if (
        !event.mock ||
        event.accountId !== routine.event!.accountId ||
        event.resourceId !== routine.event!.repositoryId ||
        event.category !== "error"
      )
        throw new Error("event_source_identity_changed");
    },
    async scan(routine, now) {
      const identity = await bound(routine);
      const page = eventRecord(
        await read("sentry_fixture_issues", { resource: routine.event!.source.resource }),
      );
      if (!Array.isArray(page.issues)) throw new Error("event_source_response_invalid");
      const events = [],
        quarantined = [];
      for (const raw of page.issues.slice(0, 20)) {
        try {
          const issue = eventRecord(raw);
          if (issue.action !== "created" || issue.category !== "error") continue;
          if (
            issue.accountId !== identity.accountId ||
            issue.projectId !== identity.repositoryId ||
            typeof issue.id !== "string"
          )
            throw new Error("event_source_identity_changed");
          events.push(
            parse(RoutineSourceEventSchema, {
              normalizerVersion: 1,
              mock: true,
              digest: eventHash(issue),
              key: `sentry-${eventHash([identity.repositoryId, issue.id]).slice(0, 32)}`,
              kind: "sentry.issue_created",
              resource: routine.event!.source.resource,
              accountId: identity.accountId,
              resourceId: identity.repositoryId,
              subjectId: issue.id,
              occurredAt: issue.firstSeen,
              receivedAt: now,
              category: "error",
              severity: String(issue.level ?? "error").slice(0, 50),
              diagnostics: `New grouped issue. Untrusted title: ${String(issue.title).slice(0, 500)}`,
            }),
          );
        } catch {
          quarantined.push({
            key: eventHash(raw).slice(0, 24),
            digest: eventHash(raw),
            reason: "Invalid issue identity or payload",
          });
        }
      }
      return { events, quarantined, cursor: now, gap: page.issues.length >= 20 };
    },
  };
}
