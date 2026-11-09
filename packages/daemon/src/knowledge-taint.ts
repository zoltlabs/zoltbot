import path from "node:path";
import type { DomainEvent, SessionTaintCause } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";

/**
 * Session taint (12 section 6.3), derived outside adapters from normalized items (I4). A session
 * that ingested content Zoltbot cannot vouch for stays tainted for the rest of its native session.
 */
const trustedKinds = new Set([
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "mode",
  "agent",
]);
const hostTools = /(?:^|__|\.)(?:team_[a-z_]+|workspace_[a-z_]+)$/;
const readKinds = new Set(["read", "search"]);
/** Shell commands that pull remote text. A heuristic: it narrows the gap, it does not close it. */
const networkCommand =
  /\b(?:curl|wget|httpie?|xh|lynx|w3m|aria2c)\b|\bInvoke-(?:WebRequest|RestMethod)\b|\bgh\s+(?:api|issue|pr|release|gist|search)\b|https?:\/\//i;
interface ToolBody {
  kind?: string;
  name?: string;
  status?: string;
  input?: unknown;
  title?: string;
  locations?: { path?: string }[];
}
interface Classified {
  cause: SessionTaintCause;
  label?: string | undefined;
}
const short = (value: string | undefined) => value?.slice(0, 120);

function classifyTool(
  body: ToolBody,
  cwd: string | undefined,
  launcher: string | undefined,
): Classified | undefined {
  // Only results that came back are ingested; a denied call returned nothing.
  if (body.status !== "ok" && body.status !== "error") return undefined;
  const name = String(body.name ?? "");
  if (body.kind === "fetch") return { cause: "fetch", label: short(name) };
  // Claude normalizes WebSearch as a search and Codex reports webSearch items; both bring in web text.
  if (/^web_?search$/i.test(name)) return { cause: "fetch", label: short(name) };
  if (body.kind === "execute" && networkCommand.test(JSON.stringify(body.input ?? "")))
    return { cause: "fetch", label: "shell network command" };
  if (/team_browser_evidence$/.test(name)) return { cause: "browser", label: short(name) };
  if (launcher && JSON.stringify(body.input ?? "").includes(launcher))
    return { cause: "browser", label: "browser CLI" };
  if (body.kind === "other" || !body.kind) {
    if (name.includes("zoltbot") && hostTools.test(name)) return undefined;
    // Server-qualified names (`mcp__server__tool`, `server.tool`) come from connected apps.
    if (/^mcp__|^[\w-]+\.[\w-]+$/.test(name)) return { cause: "connected_app", label: short(name) };
    return { cause: "unknown", label: short(name) };
  }
  if (!trustedKinds.has(body.kind)) return { cause: "unknown", label: short(name) };
  if (readKinds.has(body.kind) && cwd) {
    const root = path.resolve(cwd);
    const outside = (body.locations ?? []).find(
      (location) =>
        typeof location.path === "string" &&
        path.isAbsolute(location.path) &&
        path.resolve(location.path) !== root &&
        !path.resolve(location.path).startsWith(`${root}${path.sep}`),
    );
    if (outside) return { cause: "outside_workspace", label: short(name) };
  }
  return undefined;
}

function classifyInput(
  store: Store,
  body: { input?: { type?: string }[]; origin?: string; sourceMessageId?: string },
  projectId: string | undefined,
): Classified | undefined {
  if ((body.input ?? []).some((part) => part.type !== "text"))
    return { cause: "attachment", label: "attachment" };
  if (body.origin !== "agent") return undefined;
  const message = body.sourceMessageId
    ? (store.record("message", body.sourceMessageId) as
        | { thread?: string; fromThread?: string }
        | undefined)
    : undefined;
  // `thread` is the recipient; older messages without `fromThread` fall back to it.
  const senderId = message?.fromThread ?? message?.thread;
  const sender = senderId
    ? (store.record("thread", senderId) as { projectId?: string } | undefined)
    : undefined;
  // Unknown sender project counts as another project.
  if (!sender?.projectId || sender.projectId !== projectId)
    return { cause: "cross_project_message", label: "peer message" };
  return undefined;
}

export function readTaint(store: Store, sessionIds: readonly string[]) {
  if (!sessionIds.length) return [];
  return store.database
    .prepare(
      `SELECT session_id AS sessionId, cause, label, at FROM knowledge_session_taint WHERE session_id IN (${sessionIds.map(() => "?").join(",")}) ORDER BY at`,
    )
    .all(...sessionIds)
    .map((row) => {
      const value = row as { sessionId: string; cause: string; label: string | null; at: string };
      return {
        sessionId: value.sessionId,
        cause: value.cause as SessionTaintCause,
        ...(value.label ? { label: value.label } : {}),
        at: value.at,
      };
    });
}

/** Scan the session's ingested items once and persist the first cause. Never clears. */
export function refreshTaint(store: Store, sessionId: string) {
  const existing = readTaint(store, [sessionId])[0];
  if (existing) return existing;
  const session = store.record("session", sessionId) as
    | { cwd?: string; threadId?: string }
    | undefined;
  if (!session?.threadId) return undefined;
  const thread = store.record("thread", session.threadId) as { projectId?: string } | undefined;
  const configuration = store.record("settings", `runtime.configuration.${sessionId}`) as
    | { value?: { launchManifest?: { browser?: { launcher?: string } } } }
    | undefined;
  const launcher = configuration?.value?.launchManifest?.browser?.launcher;
  const rows = store.database
    .prepare(
      "SELECT i.kind, p.body FROM items i JOIN projection_records p ON p.kind='item' AND p.id=i.id LEFT JOIN turns t ON t.id=i.turn_id WHERE i.thread_id=? AND i.kind IN ('tool','user') AND (t.session_id=? OR json_extract(p.body,'$.body.sessionId')=?) ORDER BY i.seq",
    )
    .all(session.threadId, sessionId, sessionId) as { kind: string; body: string }[];
  for (const row of rows) {
    const body = JSON.parse(row.body).body ?? {};
    const found =
      row.kind === "tool"
        ? classifyTool(body, session.cwd, launcher)
        : classifyInput(store, body, thread?.projectId);
    if (found) return markTaint(store, sessionId, found.cause, found.label);
  }
  return undefined;
}

export function markTaint(
  store: Store,
  sessionId: string,
  cause: SessionTaintCause,
  label?: string,
) {
  store.database
    .prepare(
      "INSERT OR IGNORE INTO knowledge_session_taint(session_id,cause,label,at) VALUES(?,?,?,?)",
    )
    .run(sessionId, cause, label ?? null, new Date().toISOString());
  return readTaint(store, [sessionId])[0];
}

/** Daemon observer: re-check sessions whose tool results or inputs just changed. */
export function taintObserver(store: Store) {
  return (events: readonly DomainEvent[]) => {
    const sessions = new Set<string>();
    for (const event of events) {
      if (event.aggregateType !== "item") continue;
      const item = event.payload as {
        kind?: string;
        turnId?: string;
        body?: { sessionId?: string };
      };
      if (item.kind !== "tool" && item.kind !== "user") continue;
      const turn = item.turnId
        ? (store.record("turn", item.turnId) as { sessionId?: string } | undefined)
        : undefined;
      const sessionId = turn?.sessionId ?? item.body?.sessionId;
      if (sessionId) sessions.add(sessionId);
    }
    for (const sessionId of sessions) {
      try {
        refreshTaint(store, sessionId);
      } catch {
        // The write path rescans before every write; a missed observation is never trusted.
      }
    }
  };
}
