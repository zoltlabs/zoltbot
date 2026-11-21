// S5: the Memory page's entries and proposals, read from the daemon snapshot.
import type {
  MemoryAgent,
  MemoryEntry,
  MemoryProposal,
  MemoryView,
  MemoryWriter,
} from "../shared/memory";
import { text } from "./mapping";

type Row = Record<string, unknown>;
type Entities = Record<string, Row[] | undefined>;

const VERIFICATIONS = ["human", "unverified", "confirmed"] as const;
const STATUSES = ["active", "stale", "superseded", "archived"] as const;
const OPS = ["create", "revise", "confirm"] as const;

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function projectOf(entities: Entities, scope: unknown): { projectId: string | null; name: string } {
  const row = (scope ?? {}) as Row;
  if (row.type === "user" || !text(row.id)) return { projectId: null, name: "" };
  const kind = row.type === "project" ? "project" : text(row.type);
  const found = (entities[kind] ?? []).find((entry) => entry.id === row.id);
  // A narrower scope, such as an area, belongs to its project.
  const projectId = kind === "project" ? text(row.id) : text(found?.projectId) || null;
  const project = (entities.project ?? []).find((entry) => entry.id === projectId);
  return { projectId, name: text(project?.name) };
}

function writerOf(entities: Entities, actor: unknown): MemoryWriter {
  const row = (actor ?? {}) as Row;
  const kind = pick(row.kind, ["human", "agent", "system"] as const, "system");
  const id = text(row.id);
  if (kind !== "agent") return { kind, id, name: "" };
  const agent = (entities.agent ?? []).find((entry) => entry.id === id);
  return { kind, id, name: text(agent?.name) };
}

function agentOf(...actors: MemoryWriter[]): MemoryAgent | null {
  const agent = actors.find((actor) => actor.kind === "agent" && actor.id);
  return agent ? { id: agent.id, name: agent.name } : null;
}

export function toMemoryEntry(entities: Entities, row: Row): MemoryEntry {
  const project = projectOf(entities, row.scope);
  const writer = writerOf(entities, row.writer ?? row.owner);
  return {
    id: text(row.id),
    title: text(row.title),
    body: text(row.body),
    kind: text(row.kind),
    projectId: project.projectId,
    projectName: project.name,
    writer,
    agent: agentOf(writerOf(entities, row.owner), writer),
    verification: pick(row.verification, VERIFICATIONS, "unverified"),
    status: pick(row.status, STATUSES, "active"),
    revision: Number(row.revision) || 1,
    createdAt: text(row.createdAt),
    updatedAt: text(row.updatedAt),
    validUntil: text(row.validUntil) || null,
  };
}

/** Every entry that isn't archived, newest first, and the proposals waiting for the owner. */
export function toMemoryView(snapshot: { entities: Entities }): MemoryView {
  const { entities } = snapshot;
  const entries = (entities.knowledge ?? [])
    .filter((row) => row.status !== "archived")
    .map((row) => toMemoryEntry(entities, row))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const proposals = (entities.knowledgeProposal ?? [])
    .filter((row) => row.state === "pending")
    .map((row): MemoryProposal => {
      const project = projectOf(entities, row.scope);
      return {
        id: text(row.id),
        op: pick(row.op, OPS, "create"),
        itemId: text(row.itemId) || null,
        title: text(row.title),
        body: text(row.body),
        kind: text(row.kind),
        projectId: project.projectId,
        projectName: project.name,
        writer: writerOf(entities, row.writer),
        agent: agentOf(writerOf(entities, row.writer)),
        reason: text(row.reason),
        forget: text(row.forget) || null,
        createdAt: text(row.createdAt),
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { entries, proposals };
}
