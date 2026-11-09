import { readSchedule } from "./manage.js";
import type { Row } from "./transport.js";

/** What the sample Mac needs from FakeTransport to answer management calls. */
export interface FakeRows {
  rows(kind: string): Row[];
  find(kind: string, id: unknown): Row;
  put(kind: string, row: Row, verb?: "created" | "updated"): Row;
  at(): string;
}

const human = { kind: "human", id: "local-owner" };
const inherit = { knowledge: "inherit", skills: "inherit", connections: "inherit" };

/** Routines, runs and knowledge for the sample snapshot. */
export function sampleManagement(now: number): Record<string, Row[]> {
  const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
  const routine = (id: string, name: string, cron: string, extra: Row = {}): Row => ({
    id,
    name,
    schedule: { cron, timezone: "America/Los_Angeles" },
    template: {
      title: name,
      brief: `Run ${name.toLowerCase()} and report anything that needs me.`,
      acceptance: "",
      profileId: "builder",
      node: { type: "subproject", id: "backend" },
      inputs: inherit,
    },
    permissionCeiling: "workspace_write",
    notify: "actionable_only",
    paused: false,
    nextRunAt: at(60 * 15),
    createdAt: at(-60 * 24 * 30),
    updatedAt: at(-60 * 24 * 2),
    ...extra,
  });
  const run = (id: string, routineId: string, minutes: number, extra: Row): Row => ({
    id,
    routineId,
    scheduledAt: at(-minutes),
    notify: "actionable_only",
    createdAt: at(-minutes),
    updatedAt: at(-minutes + 5),
    ...extra,
  });
  const knowledge = (
    id: string,
    scope: Row,
    kind: string,
    title: string,
    body: string,
    extra: Row = {},
  ): Row => ({
    id,
    scope,
    kind,
    title,
    body,
    tags: [],
    sources: [],
    owner: human,
    verification: "human",
    writer: human,
    status: "active",
    revision: 1,
    createdAt: at(-60 * 24 * 10),
    updatedAt: at(-60 * 24 * 3),
    ...extra,
  });
  return {
    routine: [
      routine("routine-weekly-summary", "Weekly summary email", "0 9 * * 1"),
      routine("routine-sync-check", "Sync error check", "@every 120m", {
        paused: true,
        notify: "always",
      }),
    ],
    routineOccurrence: [
      run("run-weekly-1", "routine-weekly-summary", 60 * 24 * 4, {
        taskId: "weekly-summary",
        status: "completed",
        outcome: "actionable",
      }),
      run("run-weekly-0", "routine-weekly-summary", 60 * 24 * 11, {
        status: "missed",
        reason: "Mac was asleep",
      }),
    ],
    knowledge: [
      knowledge(
        "knowledge-short-replies",
        { type: "user", id: "local" },
        "preference",
        "Keep replies short",
        "Lead with the answer. Skip summaries of what you did unless I ask.",
      ),
      knowledge(
        "knowledge-metric",
        { type: "project", id: "zolt" },
        "decision",
        "Metric units by default",
        "Show grams and millilitres first; imperial is a setting.",
      ),
      knowledge(
        "knowledge-dependencies",
        { type: "project", id: "zolt" },
        "constraint",
        "Ask before adding dependencies",
        "New packages need a reason in the PR description.",
        { verification: "unverified", writer: { kind: "agent", id: "builder" } },
      ),
    ],
  };
}

/**
 * Skills and connections live outside the snapshot on the Mac (the skill library and the
 * connection registry), so the sample keeps them here and answers the same calls zoltd does.
 */
export class SampleManagement {
  private skills = [
    { id: "skill-release-notes", name: "release-notes", current_revision: 3 },
    { id: "skill-ui-review", name: "ui-review", current_revision: 2 },
    { id: "skill-sql-safety", name: "sql-safety", current_revision: 1 },
  ];
  private assigned = new Map<string, { skillId: string; revision: number }[]>([
    [
      "builder:zolt",
      [
        { skillId: "skill-release-notes", revision: 2 },
        { skillId: "skill-ui-review", revision: 2 },
      ],
    ],
  ]);
  private connections: Row[];

  constructor(private readonly store: FakeRows) {
    const connection = (id: string, name: string, url: string, extra: Row): Row => ({
      id,
      name,
      projectId: "zolt",
      version: 1,
      transport: { kind: "https", url },
      schemaTokens: { value: 2048, source: "estimated" },
      source: "manual",
      enabled: true,
      profileIds: ["builder"],
      credentialStatus: "connected",
      health: "healthy",
      ...extra,
    });
    this.connections = [
      connection("connection-github", "github", "https://api.githubcopilot.com/mcp", {
        credentialReference: "keychain:zoltbot:sample-github",
        checkedAt: store.at(),
      }),
      connection("connection-posthog", "posthog", "https://mcp.posthog.com/mcp", {
        credentialReference: "keychain:zoltbot:sample-posthog",
        health: "unavailable",
      }),
      connection("connection-linear", "linear", "https://mcp.linear.app/mcp", {
        enabled: false,
        credentialStatus: "needs_sign_in",
        health: "not_checked",
      }),
    ];
  }

  /** The answer to a management call, or undefined when the method is not one of these. */
  answer(method: string, p: Row): unknown {
    const now = this.store.at();
    switch (method) {
      case "routine.history":
        return {
          items: this.store.rows("routineOccurrence").filter((row) => row.routineId === p.id),
        };
      case "routine.update": {
        const old = this.store.find("routine", p.id);
        if (old.event) throw new Error("use_event_routine_commands");
        if (old.updatedAt !== p.expectedUpdatedAt) throw new Error("stale_revision");
        const schedule = p.schedule as { cron: string; timezone: string } | undefined;
        if (schedule && readSchedule(schedule.cron).kind === "other")
          throw new Error("invalid_routine_schedule");
        const resumed = old.paused === true && p.paused === false;
        return this.store.put("routine", {
          ...old,
          ...(schedule ? { schedule } : {}),
          ...(p.notify ? { notify: p.notify } : {}),
          ...(typeof p.paused === "boolean" ? { paused: p.paused } : {}),
          ...(schedule || resumed
            ? { nextRunAt: new Date(Date.parse(now) + 12 * 3_600_000).toISOString() }
            : {}),
          updatedAt: now,
        });
      }
      case "routine.pause": {
        const old = this.store.find("routine", p.id);
        if (!old.event) throw new Error("use_routine_update");
        return this.store.put("routine", { ...old, paused: true, updatedAt: now });
      }
      case "knowledge.upsert": {
        const value = p.value as Row;
        const old = this.store.rows("knowledge").find((row) => row.id === value.id);
        if (old ? old.revision !== p.expectedRevision : p.expectedRevision !== 0)
          throw new Error(old ? "knowledge_revision_conflict" : "knowledge_not_found");
        return this.store.put(
          "knowledge",
          {
            ...value,
            writer: human,
            verification: "human",
            revision: Number(old?.revision ?? 0) + 1,
            createdAt: old?.createdAt ?? now,
            updatedAt: now,
          },
          old ? "updated" : "created",
        );
      }
      case "knowledge.archive": {
        const old = this.store.find("knowledge", p.id);
        if (typeof p.expectedRevision === "number" && p.expectedRevision !== old.revision)
          throw new Error("knowledge_revision_conflict");
        this.store.put("knowledge", {
          ...old,
          status: "archived",
          revision: Number(old.revision) + 1,
          updatedAt: now,
        });
        return { ok: true };
      }
      case "skill.list":
        return { skills: structuredClone(this.skills) };
      case "skill.assignments":
        return {
          assignments: structuredClone(this.assigned.get(`${p.profileId}:${p.scopeId}`) ?? []),
        };
      case "skill.access": {
        if (p.enabled === true && p.confirmed !== true)
          throw new Error("skill_enable_confirmation_required");
        const key = `${p.profileId}:${p.scopeId}`;
        const rest = (this.assigned.get(key) ?? []).filter((row) => row.skillId !== p.skillId);
        this.assigned.set(
          key,
          p.enabled === true
            ? [...rest, { skillId: String(p.skillId), revision: Number(p.revision) }]
            : rest,
        );
        return { ok: true };
      }
      case "connection.list":
        return {
          items: structuredClone(
            p.projectId
              ? this.connections.filter((row) => row.projectId === p.projectId)
              : this.connections,
          ),
        };
      case "connection.test": {
        const old = this.connection(p.id);
        const healthy = old.id !== "connection-posthog";
        this.save({ ...old, health: healthy ? "healthy" : "unavailable", checkedAt: now });
        if (!healthy) throw new Error("connection_health_failed");
        return { ok: true };
      }
      case "connection.affectedSessions":
        this.connection(p.id);
        return { sessionIds: p.id === "connection-github" ? ["session-meal"] : [] };
      case "connection.disconnect": {
        if (p.confirmed !== true) throw new Error("connection_confirmation_required");
        const old = this.connection(p.id);
        const ids = p.id === "connection-github" ? ["session-meal"] : [];
        if (ids.length && p.stopSessions !== true) throw new Error("connection_active_sessions");
        if (
          old.version !== p.expectedVersion ||
          JSON.stringify(ids) !==
            JSON.stringify([...((p.expectedSessionIds as string[]) ?? [])].sort())
        )
          throw new Error("connection_disconnect_changed");
        const { credentialReference: _, ...without } = old;
        this.save({
          ...without,
          enabled: false,
          version: Number(old.version) + 1,
          credentialStatus: "needs_sign_in",
          health: "not_checked",
        });
        return { ok: true };
      }
      default:
        return undefined;
    }
  }

  private connection(id: unknown) {
    const row = this.connections.find((entry) => entry.id === id);
    if (!row) throw new Error("connection_not_found");
    return row;
  }
  private save(row: Row) {
    this.connections = this.connections.map((entry) => (entry.id === row.id ? row : entry));
  }
}
