import type { Row } from "../chat/types.js";

export type TimelineRow =
  | { type: "message"; key: string; item: Row }
  | { type: "artifact"; key: string; artifact: Row; versions: Row[]; turnId: string };

/** A display projection only: never writes synthetic items into native conversation history. */
export function artifactTimeline(items: Row[], artifacts: Row[], versions: Row[]): TimelineRow[] {
  if (!versions.length || !artifacts.length)
    return items.map((item) => ({ type: "message", key: `message:${String(item.id)}`, item }));
  const lastItem = new Map<string, string>();
  for (const item of items)
    if (typeof item.turnId === "string") lastItem.set(item.turnId, String(item.id));
  const byId = new Map(artifacts.filter((a) => a.state !== "archived").map((a) => [a.id, a]));
  const groups = new Map<string, Extract<TimelineRow, { type: "artifact" }>>();
  for (const version of new Map(versions.map((v) => [v.id, v])).values()) {
    const artifact = byId.get(version.artifactId);
    if (!artifact || typeof version.turnId !== "string" || !lastItem.has(version.turnId)) continue;
    const key = `artifact:${version.turnId}:${String(artifact.id)}`;
    const group = groups.get(key) ?? {
      type: "artifact",
      key,
      artifact,
      versions: [],
      turnId: version.turnId,
    };
    group.versions.push(version);
    groups.set(key, group);
  }
  const after = new Map<string, Extract<TimelineRow, { type: "artifact" }>[]>();
  for (const group of groups.values()) {
    group.versions.sort(
      (a, b) => Number(a.number) - Number(b.number) || String(a.id).localeCompare(String(b.id)),
    );
    const id = lastItem.get(group.turnId) as string;
    after.set(id, [...(after.get(id) ?? []), group]);
  }
  return items.flatMap((item): TimelineRow[] => [
    { type: "message", key: `message:${String(item.id)}`, item },
    ...(after.get(String(item.id)) ?? []).sort((a, b) => a.key.localeCompare(b.key)),
  ]);
}
