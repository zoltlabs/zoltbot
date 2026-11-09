import { expect, it } from "vitest";
import { visualOptions } from "./comparison-data.js";

const at = "2026-11-01T12:00:00Z";
const artifact = {
  id: "artifact",
  threadId: "thread",
  key: "mockup",
  kind: "design",
  title: "Mockup",
  currentVersionId: "v2",
  starredVersionIds: [],
  provider: "fake",
  profileId: "profile",
  state: "active",
  repositoryState: "local",
  createdAt: at,
  updatedAt: at,
};
const version = {
  id: "v1",
  artifactId: "artifact",
  number: 1,
  manifestHash: "hash",
  totalBytes: 10,
  fileCount: 1,
  sessionId: "session",
  turnId: "turn",
  note: "",
  auto: false,
  held: false,
  metadataOnly: false,
  thumbnailState: "pending",
  thumbnails: {},
  reviewState: "unreviewed",
  createdAt: at,
};
it("offers exact historical and current versions only within the selected conversations", () => {
  const result = visualOptions(
    [artifact, { ...artifact, id: "other", threadId: "other" }],
    [
      version,
      { ...version, id: "v2", number: 2 },
      { ...version, id: "held", held: true },
      { ...version, id: "remote", metadataOnly: true },
      { ...version, id: "other-version", artifactId: "other" },
    ],
    ["thread"],
  );
  expect(result.map((entry) => entry.version.id)).toEqual(["v2", "v1"]);
  expect(visualOptions([{ ...artifact, state: "archived" }], [version], ["thread"])).toEqual([]);
  expect(visualOptions([{ ...artifact, kind: "external" }], [version], ["thread"])).toEqual([]);
});
