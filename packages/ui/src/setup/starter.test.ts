import { expect, it } from "vitest";
import { starterDraft } from "./starter.js";

it("starts with workspace write and native model defaults without sending an implicit prompt", () => {
  const draft = starterDraft(
    { id: "sample", displayName: "Sample" },
    { profile: "profile", thread: "thread" },
    "2026-10-28T12:00:00Z",
  );
  expect(draft.profile).toMatchObject({
    definitionId: "sample",
    kind: "profile",
    permissionProfile: "workspace_write",
    instructions: "",
  });
  expect(draft.profile).not.toHaveProperty("model");
  expect(draft.profile).not.toHaveProperty("effort");
  expect(draft.thread).toMatchObject({ agentId: "profile", kind: "main", titleSource: "auto" });
  expect(draft).not.toHaveProperty("input");
});

it("assigns an explicitly chosen project only to the new conversation", () => {
  const draft = starterDraft(
    { id: "sample", displayName: "Sample" },
    { profile: "profile", thread: "thread" },
    "2026-10-29T00:00:00Z",
    "chosen-project",
  );
  expect(draft.thread.projectId).toBe("chosen-project");
  expect(draft.profile).not.toHaveProperty("projectId");
  expect(
    starterDraft(
      { id: "sample", displayName: "Sample" },
      { profile: "profile", thread: "thread" },
      "2026-10-29T00:00:00Z",
    ).thread,
  ).not.toHaveProperty("projectId");
});
