import { fileDiffs } from "./tools/diff-data.js";
import { body, type Row, text } from "./types.js";

type Entities = Record<string, Row[] | undefined>;
export function threadResults(entities: Entities, threadId: string) {
  const items = (entities.item ?? []).filter((row) => row.threadId === threadId);
  const turns = (entities.turn ?? []).filter((row) => row.threadId === threadId);
  const latestTurn = [...turns].sort(
    (a, b) =>
      text(b.startedAt).localeCompare(text(a.startedAt)) || text(b.id).localeCompare(text(a.id)),
  )[0];
  const task = entities.task?.find((row) => row.threadId === threadId);
  const result =
    task &&
    entities.taskResult?.find((row) => row.taskId === task.id && row.revision === task.revision);
  const artifacts = (entities.artifact ?? []).filter(
    (row) => row.threadId === threadId && row.state !== "archived",
  );
  const requests = (entities.interaction ?? []).filter(
    (row) => row.threadId === threadId && row.state === "pending",
  );
  const children = task ? (entities.task ?? []).filter((row) => row.parentId === task.id) : [];
  const diffs = items
    .filter(
      (row) => row.turnId === latestTurn?.id && row.kind === "tool" && body(row).kind === "edit",
    )
    .flatMap((row) => fileDiffs(body(row).diffs));
  // Only explicit web links from agent replies; never interpret tool output as navigation.
  const links = new Map<string, string>();
  for (const item of items) {
    if (item.kind !== "message") continue;
    for (const match of text(body(item).text).matchAll(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g)) {
      try {
        const url = new URL(match[2] ?? "");
        if (url.username || url.password) continue;
        links.set(url.href, match[1] ?? url.hostname);
      } catch {
        /* Invalid links stay in the transcript. */
      }
    }
  }
  const queued = items.some(
    (row) =>
      row.kind === "user" &&
      ["queued", "sending", "uncertain"].includes(text(body(row).queueState)),
  );
  const sessions = (entities.session ?? []).filter((row) => row.threadId === threadId);
  const background = sessions.some(
    (row) =>
      Array.isArray(row.background) &&
      row.background.some((entry: Row) => entry.state === "running"),
  );
  const working =
    turns.some((row) => row.status === "running") ||
    children.some((row) => ["queued", "running", "blocked"].includes(text(row.state))) ||
    background;
  const complete =
    latestTurn?.status === "completed" &&
    !working &&
    !queued &&
    !requests.length &&
    (!task || ["review", "completed"].includes(text(task.state)));
  return {
    latestTurn,
    task,
    result,
    artifacts,
    requests,
    children,
    diffs,
    links: [...links].map(([url, label]) => ({ url, label })),
    complete,
  };
}
