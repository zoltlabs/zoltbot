import { markRecovered } from "./activity-data.js";
import { threadResults } from "./results-data.js";
import { fileDiffs } from "./tools/diff-data.js";
import { body, type Row, text } from "./types.js";

/** Evidence comes from this turn's normalized events, never from command names or reply text. */
export function completionReceipt(entities: Record<string, Row[] | undefined>, threadId: string) {
  const data = threadResults(entities, threadId);
  const items = markRecovered(
    (entities.item ?? [])
      .filter((item) => item.threadId === threadId && item.turnId === data.latestTurn?.id)
      .sort((a, b) => Number(a.seq) - Number(b.seq)),
  );
  const commands = items.filter((item) => item.kind === "tool" && body(item).kind === "execute");
  const completed = commands.filter((item) => body(item).status === "ok").length;
  const failed = items.filter(
    (item) =>
      item.kind === "tool" &&
      ["error", "denied"].includes(text(body(item).status)) &&
      body(item).recovered !== true,
  ).length;
  const diffs = items
    .filter(
      (item) => item.kind === "tool" && body(item).kind === "edit" && body(item).status === "ok",
    )
    .flatMap((item) => fileDiffs(body(item).diffs));
  const files = new Set(diffs.map((diff) => diff.path).filter(Boolean)).size;
  const produced = data.artifacts.some((artifact) =>
    (entities.artifactVersion ?? []).some(
      (version) => version.artifactId === artifact.id && version.turnId === data.latestTurn?.id,
    ),
  );
  const parts = [
    files ? `${files} ${files === 1 ? "file" : "files"} changed` : "",
    completed ? `${completed} ${completed === 1 ? "command" : "commands"} completed` : "",
    failed ? `${failed} ${failed === 1 ? "step" : "steps"} failed` : "",
  ].filter(Boolean);
  return {
    ...data,
    diffs,
    files,
    completed,
    failed,
    summary:
      parts.join(" · ") || (data.task?.state === "review" ? "Ready to review" : "Results ready"),
    visible: data.complete && !!(parts.length || data.task || produced || data.result),
    action: files ? ("changes" as const) : ("results" as const),
    actionLabel: files ? "Review changes" : "View results",
  };
}
