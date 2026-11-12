import type { DomainEvent } from "@zoltbot/protocol";
import type { SqlDriver } from "./driver.js";

export const tableMap: Record<string, string> = {
  view: "view_records",
  initiativeRecord: "initiative_records",
  managerRemit: "manager_remits",
  companyPlan: "company_plans",
  projectBrief: "project_briefs",
  wake: "wakes",
  compare: "compares",
  compareMember: "compare_members",
  orchestration: "orchestrations",
  shipping: "shipping",
  shippingOperation: "shipping_operations",
  shippingFeedback: "shipping_feedback",
  artifact: "artifacts",
  artifactVersion: "artifact_versions",
  artifactComment: "artifact_comments",
  agentDefinition: "agent_definitions",
  agent: "agents",
  project: "projects",
  subproject: "subprojects",
  area: "areas",
  initiative: "initiatives",
  thread: "threads",
  session: "sessions",
  turn: "turns",
  item: "item_records",
  interaction: "interactions",
  rule: "approval_rules",
  message: "messages",
  delivery: "deliveries",
  grant: "grants",
  task: "tasks",
  taskResult: "task_results",
  workspace: "workspaces",
  nativeSession: "native_sessions",
  usage: "usage_records_aux",
  audit: "audit_log",
  settings: "settings",
  device: "devices",
  knowledge: "knowledge_items",
  contextPack: "context_packs",
  knowledgeProposal: "knowledge_proposals",
  deliverable: "legacy_deliverables",
  workflow: "workflow_versions",
  workflowRun: "workflow_runs",
  routine: "routines",
  routineOccurrence: "routine_occurrences",
};
const aliases: Record<string, string> = {
  thread: "thread_id",
  task: "task_id",
  from: "from_ref",
  root: "root_id",
  key: "key",
  owner: "owner",
  scopeId: "scope_id",
};
const snake = (key: string) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const sqlValue = (value: unknown): string | number | null =>
  value === undefined || value === null
    ? null
    : typeof value === "boolean"
      ? Number(value)
      : typeof value === "number" || typeof value === "string"
        ? value
        : JSON.stringify(value);
/** Events written before migration 014 predate agent writes: a person wrote them. */
function legacyKnowledge(body: Record<string, unknown>) {
  return body.verification ? body : { ...body, verification: "human", writer: body.owner };
}
interface Column {
  name: string;
  pk: number;
  notnull: number;
  dflt_value: unknown;
}
const columnCache = new WeakMap<SqlDriver, Map<string, Column[]>>();
export function clearProjectionCache(database: SqlDriver) {
  columnCache.delete(database);
}
function tableColumns(database: SqlDriver, table: string): Column[] {
  let tables = columnCache.get(database);
  if (!tables) {
    tables = new Map();
    columnCache.set(database, tables);
  }
  let columns = tables.get(table);
  if (!columns) {
    columns = database.prepare(`PRAGMA table_info("${table}")`).all() as Column[];
    tables.set(table, columns);
  }
  return columns;
}
export function applyProjection(database: SqlDriver, event: DomainEvent) {
  const table = tableMap[event.aggregateType];
  if (!table) throw new Error(`Unknown projection aggregate: ${event.aggregateType}`);
  const body =
    event.aggregateType === "knowledge"
      ? legacyKnowledge(event.payload as Record<string, unknown>)
      : (event.payload as Record<string, unknown>);
  const row: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) row[aliases[key] ?? snake(key)] = value;
  if (event.aggregateType === "task") {
    const independent =
      body.initiativeId &&
      database.prepare("SELECT id FROM initiative_records WHERE id=?").get(body.initiativeId);
    row.initiative_record_id = independent ? body.initiativeId : null;
    row.initiative_id = independent ? null : (body.initiativeId ?? null);
  }
  if (event.aggregateType === "agentDefinition") {
    row.body = body;
    row.source = "builtin";
  }
  if (event.aggregateType === "routineOccurrence")
    row.event_origin = body.sourceEvent || body.eventMeta ? 1 : 0;
  if (event.aggregateType === "settings") row.key = body.key ?? event.aggregateId;
  if (body.scope && typeof body.scope === "object") {
    const scope = body.scope as { type: string; id: string };
    row.scope_type = scope.type;
    row.scope_id = scope.id;
  }
  if (event.aggregateType === "rule") {
    row.tool = (body.matcher as { tool: string }).tool;
  }
  if (event.aggregateType === "workflow") {
    database
      .prepare(
        "INSERT INTO workflows(id,scope_type,scope_id,name,current_version,enabled,created_at) VALUES(?,?,?,?,?,0,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,current_version=excluded.current_version",
      )
      .run(
        body.workflowId,
        row.scope_type,
        row.scope_id,
        body.name,
        body.version,
        event.occurredAt,
      );
    row.body = body;
    row.created_by = "system";
  }
  if (event.aggregateType === "item") {
    const previous = database
      .prepare("SELECT rowid,id,thread_id,body FROM items WHERE id=?")
      .get(event.aggregateId) as
      | { rowid: number; id: string; thread_id: string; body: string }
      | undefined;
    if (previous)
      database
        .prepare(
          "INSERT INTO items_fts(items_fts,rowid,id,thread_id,text) VALUES('delete',?,?,?,?)",
        )
        .run(previous.rowid, previous.id, previous.thread_id, previous.body);
    row.body = {};
    row.body_event_id = event.eventId;
  }
  const columns = tableColumns(database, table);
  for (const col of columns) {
    if (row[col.name] !== undefined) continue;
    if (col.name === "created_at" || col.name === "updated_at") row[col.name] = event.occurredAt;
    if (col.name === "id") row.id = event.aggregateId;
    if (col.name === "body" && event.aggregateType === "interaction") row.body = body;
  }
  const present = columns.filter((col) => row[col.name] !== undefined);
  const names = present.map((c) => `"${c.name}"`);
  const keys = columns.filter((c) => c.pk).map((c) => `"${c.name}"`);
  const updates = present.filter((c) => !c.pk).map((c) => `"${c.name}"=excluded."${c.name}"`);
  database
    .prepare(
      `INSERT INTO "${table}"(${names.join(",")}) VALUES(${names.map(() => "?").join(",")}) ON CONFLICT(${keys.join(",")}) DO ${updates.length ? `UPDATE SET ${updates.join(",")}` : "NOTHING"}`,
    )
    .run(...present.map((c) => sqlValue(row[c.name])));
  database
    .prepare(
      "INSERT INTO projection_rows(kind,id,body,body_event_id) VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body,body_event_id=excluded.body_event_id",
    )
    .run(
      event.aggregateType,
      event.aggregateId,
      JSON.stringify(
        event.aggregateType === "item"
          ? Object.fromEntries(Object.entries(body).filter(([key]) => key !== "body"))
          : body,
      ),
      event.aggregateType === "item" ? event.eventId : null,
    );
  if (event.aggregateType === "artifact") {
    database.prepare("DELETE FROM artifacts_fts WHERE id=?").run(event.aggregateId);
    const aux = database
      .prepare("SELECT visible_text FROM artifact_manifests_aux WHERE version_id=?")
      .get(body.currentVersionId) as { visible_text: string } | undefined;
    const version = database
      .prepare("SELECT body FROM projection_records WHERE kind='artifactVersion' AND id=?")
      .get(body.currentVersionId) as { body: string } | undefined;
    database
      .prepare("INSERT INTO artifacts_fts(id,title,note,text) VALUES(?,?,?,?)")
      .run(
        event.aggregateId,
        body.title,
        version ? JSON.parse(version.body).note : "",
        aux?.visible_text ?? "",
      );
  }
  if (event.aggregateType === "item") {
    database
      .prepare(
        "INSERT INTO items_fts(rowid,id,thread_id,text) SELECT rowid,id,?,? FROM items WHERE id=?",
      )
      .run(body.threadId, JSON.stringify(body.body), event.aggregateId);
  }
  if (event.aggregateType === "knowledge") {
    database.prepare("DELETE FROM knowledge_fts WHERE id=?").run(event.aggregateId);
    database
      .prepare("INSERT INTO knowledge_fts(id,text) VALUES(?,?)")
      .run(event.aggregateId, `${body.title} ${body.body} ${(body.tags as string[]).join(" ")}`);
  }
}
