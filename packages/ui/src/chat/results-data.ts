import { compareSessions } from "@zoltbot/protocol";
import { backgroundTasks } from "./parity-data.js";
import { fileDiffs } from "./tools/diff-data.js";
import { body, type Row, text } from "./types.js";

type Entities = Record<string, Row[] | undefined>;

/** Task children and manager delegations use the relationships already recorded by the daemon. */
export function delegatedWork(entities: Entities, threadId: string): Row[] {
  const task = entities.task?.find((row) => row.threadId === threadId);
  const children = task ? (entities.task ?? []).filter((row) => row.parentId === task.id) : [];
  const ids = new Set(
    (entities.audit ?? [])
      .filter(
        (row) =>
          row.action === "manager.delegate" &&
          (row.detail as Row | undefined)?.managerThreadId === threadId,
      )
      .map((row) => text(row.target)),
  );
  const linked = (entities.thread ?? []).filter(
    (row) => ids.has(text(row.id)) && !children.some((task) => task.threadId === row.id),
  );
  return [
    ...children,
    ...linked.map((thread) => {
      const turns = (entities.turn ?? [])
        .filter((row) => row.threadId === thread.id)
        .sort((a, b) => text(b.startedAt).localeCompare(text(a.startedAt)));
      const needs = entities.interaction?.some(
        (row) => row.threadId === thread.id && row.state === "pending",
      );
      const queued = entities.item?.some(
        (row) =>
          row.threadId === thread.id &&
          row.kind === "user" &&
          ["queued", "sending", "uncertain"].includes(text(body(row).queueState)),
      );
      const state = needs
        ? "needs_you"
        : turns.some((row) => row.status === "running")
          ? "running"
          : queued
            ? "queued"
            : text(turns[0]?.status) || "idle";
      return { id: thread.id, threadId: thread.id, title: thread.title, state };
    }),
  ];
}
export const delegatedActive = (row: Row) =>
  ["queued", "running", "blocked", "needs_you"].includes(text(row.state));
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
  const children = delegatedWork(entities, threadId);
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
  const session = (entities.session ?? [])
    .filter((row) => row.threadId === threadId)
    .sort(compareSessions)[0];
  const background = backgroundTasks(session).some((task) => task.state === "running");
  const working =
    turns.some((row) => row.status === "running") || children.some(delegatedActive) || background;
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
