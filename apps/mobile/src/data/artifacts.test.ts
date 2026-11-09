import { expect, it } from "vitest";
import { transcript } from "./timeline.js";
import type { Snapshot } from "./transport.js";

function fixture(): Snapshot {
  return {
    seq: 1,
    counters: {},
    entities: {
      thread: [
        { id: "chat", projectId: "project" },
        { id: "other", projectId: "project" },
      ],
      session: [
        { id: "session", threadId: "chat" },
        { id: "other-session", threadId: "other" },
      ],
      turn: [
        { id: "t1", threadId: "chat" },
        { id: "t2", threadId: "chat" },
      ],
      item: [
        {
          id: "m1",
          threadId: "chat",
          turnId: "t1",
          seq: 1,
          kind: "message",
          body: { text: "Source explanation" },
        },
        {
          id: "m2",
          threadId: "chat",
          turnId: "t2",
          seq: 2,
          kind: "message",
          body: { text: "Revised explanation" },
        },
      ],
      artifact: [
        {
          id: "a",
          threadId: "other",
          projectId: "project",
          title: "Activity",
          kind: "page",
          state: "active",
          currentVersionId: "v3",
        },
      ],
      artifactVersion: [
        {
          id: "v1",
          artifactId: "a",
          sessionId: "session",
          turnId: "t1",
          number: 1,
          note: "Do not copy source or notes to the phone card",
        },
        { id: "v2", artifactId: "a", sessionId: "session", turnId: "t1", number: 2 },
        { id: "v3", artifactId: "a", sessionId: "session", turnId: "t2", number: 3 },
      ],
    },
  };
}

it("keeps historical occurrence versions at their producing turn as new messages stream", () => {
  const snapshot = fixture();
  snapshot.entities.artifactVersion?.push({ ...snapshot.entities.artifactVersion[0] });
  const rows = transcript(snapshot, "chat");
  expect(rows.map((row) => row.id)).toEqual(["m1", "artifact:t1:a", "m2", "artifact:t2:a"]);
  expect(rows[1]?.artifact).toMatchObject({ versionId: "v2", number: 2, newer: true });
  expect(rows[3]?.artifact).toMatchObject({ versionId: "v3", number: 3, newer: false });
  expect(JSON.stringify(rows)).not.toContain("Do not copy source");
  snapshot.entities.item?.push({
    id: "m3",
    threadId: "chat",
    turnId: "t2",
    seq: 3,
    kind: "message",
    body: { text: "Streaming" },
  });
  expect(transcript(snapshot, "chat").map((row) => row.id)).toEqual([
    "m1",
    "artifact:t1:a",
    "m2",
    "m3",
    "artifact:t2:a",
  ]);
});

it("provides unloaded-turn fallback and distinguishes held and unavailable files without loading source", () => {
  const snapshot = fixture();
  snapshot.entities.item = snapshot.entities.item?.filter((row) => row.turnId !== "t1") ?? [];
  Object.assign(snapshot.entities.artifactVersion?.[1] ?? {}, { held: true });
  Object.assign(snapshot.entities.artifactVersion?.[2] ?? {}, { metadataOnly: true });
  const rows = transcript(snapshot, "chat");
  expect(rows.at(-1)).toMatchObject({
    id: "artifact:t1:a",
    unanchored: true,
    artifact: { availability: "held" },
  });
  expect(rows[1]).toMatchObject({ artifact: { availability: "unavailable" } });
});

it("does not add another chat's versions, archived artifacts or another workspace's artifacts", () => {
  const snapshot = fixture();
  snapshot.entities.artifactVersion?.push({
    id: "foreign",
    artifactId: "a",
    sessionId: "other-session",
    turnId: "other-turn",
    number: 4,
  });
  expect(transcript(snapshot, "chat").filter((row) => row.kind === "artifact")).toHaveLength(2);
  Object.assign(snapshot.entities.artifact?.[0] ?? {}, { projectId: "foreign-project" });
  expect(transcript(snapshot, "chat").filter((row) => row.kind === "artifact")).toHaveLength(0);
  Object.assign(snapshot.entities.artifact?.[0] ?? {}, { projectId: "project", state: "archived" });
  expect(transcript(snapshot, "chat").filter((row) => row.kind === "artifact")).toHaveLength(0);
});

it("shows a selected old version in human messages and never substitutes current when it is missing", () => {
  const snapshot = fixture();
  snapshot.entities.item?.unshift({
    id: "input",
    threadId: "chat",
    turnId: "t1",
    seq: 0,
    kind: "user",
    body: {
      input: [{ type: "text", text: "Revise this" }],
      artifactTarget: { artifactId: "a", versionId: "v1" },
    },
  });
  expect(transcript(snapshot, "chat")[0]).toMatchObject({
    text: "Revise this",
    artifactReference: "Activity · v1",
  });
  snapshot.entities.artifactVersion =
    snapshot.entities.artifactVersion?.filter((row) => row.id !== "v1") ?? [];
  expect(transcript(snapshot, "chat")[0]?.artifactReference).toBe(
    "Activity · selected version unavailable",
  );
});

it("anchors a subagent visual after its containing tool without flattening nested steps", () => {
  const snapshot = fixture();
  snapshot.entities.item?.unshift({
    id: "parent",
    threadId: "chat",
    turnId: "t1",
    seq: 0,
    kind: "tool",
    body: { title: "Explore activity", status: "ok" },
  });
  Object.assign(snapshot.entities.item?.find((row) => row.id === "m1") ?? {}, {
    body: { text: "Nested explanation", parentItemId: "parent" },
  });
  const rows = transcript(snapshot, "chat");
  expect(rows.map((row) => row.id)).toEqual(["parent", "artifact:t1:a", "m2", "artifact:t2:a"]);
  expect(rows[0]?.children?.[0]?.text).toBe("Nested explanation");
});
