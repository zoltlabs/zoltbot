import type { EntityKind } from "@zoltbot/protocol";
import type { SqlDriver } from "./driver.js";
import { tableMap } from "./projections.js";
import type { Snapshot } from "./store.js";

export type ReadScope =
  | { projectId: string; taskId?: never }
  | { taskId: string; projectId?: never };

/** Load owned rows through indexed lookups, then add only their referenced parent records. */
export function scopedRead(
  database: SqlDriver,
  scope: ReadScope,
  kinds?: readonly EntityKind[],
): Snapshot {
  const selected = [...new Set(kinds ?? Object.keys(tableMap))];
  if (selected.some((kind) => !Object.hasOwn(tableMap, kind)))
    throw new Error("invalid_read_kinds");
  if (!selected.length) return {};
  const project = "projectId" in scope && scope.projectId !== undefined;
  const id = project ? scope.projectId : scope.taskId;
  if (!id || typeof id !== "string" || (scope.projectId && scope.taskId))
    throw new Error("invalid_read_scope");
  const column = project ? "projectId" : "taskId";
  const threads = project
    ? "SELECT id FROM threads WHERE project_id=?"
    : "SELECT id FROM threads WHERE task_id=? UNION SELECT thread_id FROM tasks WHERE id=?";
  const threadBindings = project ? [id] : [id, id];
  // The platform restricts compound SELECTs more tightly than desktop SQLite.
  // Separate indexed ID lookups avoid that limit without loading any message bodies.
  const common = `WITH requested_kinds(kind) AS (SELECT value FROM json_each(?)),
    scoped_threads AS (${threads}), scoped_messages AS (
      SELECT id FROM messages WHERE thread_id IN (SELECT id FROM scoped_threads)
      UNION SELECT id FROM messages WHERE task_id IN (SELECT id FROM tasks WHERE ${project ? "project_id" : "id"}=?)
    )`;
  const lookups: [string, unknown[]][] = [
    ["kind=? AND id=?", [project ? "project" : "task", id]],
    [`json_extract(body,'$.${column}')=?`, [id]],
    ["kind='thread' AND id IN (SELECT id FROM scoped_threads)", []],
    ["json_extract(body,'$.threadId') IN (SELECT id FROM scoped_threads)", []],
    ["kind='message' AND id IN (SELECT id FROM scoped_messages)", []],
    [
      "kind='delivery' AND id IN (SELECT id FROM deliveries WHERE message_id IN (SELECT id FROM scoped_messages))",
      [],
    ],
    [
      "json_extract(body,'$.scope.type')=? AND json_extract(body,'$.scope.id')=?",
      [project ? "project" : "task", id],
    ],
  ];
  const rows = lookups.flatMap(
    ([predicate, bindings]) =>
      database
        .prepare(`${common} SELECT kind,id FROM projection_rows
      WHERE kind IN (SELECT kind FROM requested_kinds) AND ${predicate} ORDER BY kind,id`)
        .all(JSON.stringify(selected), ...threadBindings, id, ...bindings) as {
        kind: EntityKind;
        id: string;
      }[],
  );
  rows.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  const state: Snapshot = {};
  const seen = new Set<string>();
  const add = (kind: EntityKind, recordId: unknown) => {
    if (typeof recordId !== "string" || seen.has(`${kind}:${recordId}`)) return;
    const row = database
      .prepare("SELECT body FROM projection_records WHERE kind=? AND id=?")
      .get(kind, recordId) as { body: string } | undefined;
    if (row) append(kind, JSON.parse(row.body), recordId);
  };
  const append = (kind: EntityKind, body: Record<string, unknown>, recordId: string) => {
    const key = `${kind}:${recordId}`;
    if (seen.has(key)) return;
    seen.add(key);
    const entries = state[kind] ?? [];
    entries.push(body);
    state[kind] = entries;
    // These are references to shared configuration, not permission to read other tasks.
    add("project", body.projectId);
    add("agent", body.agentId ?? body.ownerAgentId);
    add("agentDefinition", body.definitionId);
    add("workspace", body.workspaceId);
    add("subproject", body.subprojectId);
    add("area", body.areaId);
    add("initiative", body.initiativeId);
    add("initiativeRecord", body.initiativeId);
  };
  for (const row of rows) add(row.kind, row.id);
  return state;
}
