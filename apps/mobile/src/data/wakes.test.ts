import { expect, it } from "vitest";
import type { Snapshot } from "./transport";
import { type WakeForm, wakeInput, wakeSources } from "./wakes";

const form: WakeForm = {
  kind: "pr",
  selected: "",
  repository: "example/repo",
  number: "12",
  attempt: "1",
  phrase: "release",
  outcome: "passed",
  behavior: "inbox",
  continuation: "",
  fallback: "2099-12-01T09:30",
};
it("builds all six wake conditions and forces topic waits to inbox", () => {
  expect(wakeInput("chat", "project", form).condition).toEqual({
    kind: "pr",
    repository: "example/repo",
    number: 12,
  });
  expect(wakeInput("chat", "project", { ...form, kind: "ci" }).condition).toEqual({
    kind: "ci",
    repository: "example/repo",
    runId: "12",
    attempt: 1,
    outcome: "passed",
  });
  expect(
    wakeInput("chat", "project", { ...form, kind: "job", selected: "session%7C1|job%2F2" })
      .condition,
  ).toEqual({ kind: "job", sessionId: "session|1", jobId: "job/2", outcome: "passed" });
  for (const kind of ["task", "turn"] as const)
    expect(
      wakeInput("chat", "project", { ...form, kind, selected: "source" }).condition,
    ).toMatchObject({ kind, [`${kind}Id`]: "source" });
  expect(
    wakeInput("chat", "project", { ...form, kind: "topic", behavior: "resume" }).behavior,
  ).toBe("inbox");
});
it("rejects invalid or past fallback, missing resume instructions and malformed sources", () => {
  for (const fallback of ["", "yesterday", "2000-01-01T09:30", "2099-02-31T09:30"])
    expect(() => wakeInput("chat", "project", { ...form, fallback })).toThrow();
  for (const patch of [
    { behavior: "resume" as const },
    { number: "0" },
    { repository: "bad" },
    { kind: "task" as const, selected: "" },
    { kind: "ci" as const, attempt: "0" },
  ])
    expect(() => wakeInput("chat", "project", { ...form, ...patch })).toThrow();
  expect(() => wakeInput("chat", "", { ...form, kind: "topic" })).toThrow("workspace");
});
it("offers exact dependencies only from unarchived chats in the same workspace", () => {
  const s: Snapshot = {
    seq: 1,
    counters: {},
    entities: {
      thread: [
        { id: "chat", projectId: "p" },
        { id: "same", projectId: "p" },
        { id: "foreign", projectId: "q" },
        { id: "archived", projectId: "p", archived: true },
      ],
      task: ["chat", "same", "foreign", "archived"].map((id) => ({ id, threadId: id })),
      session: [
        { id: "s", threadId: "same", background: [{ id: "job", state: "running" }] },
        { id: "f", threadId: "foreign", background: [{ id: "secret" }] },
      ],
      turn: [
        { id: "mine", threadId: "chat" },
        { id: "other", threadId: "same" },
      ],
    },
  };
  expect(wakeSources(s, "chat", "task").map((s) => s.value)).toEqual(["same"]);
  expect(wakeSources(s, "chat", "job").map((s) => s.value)).toEqual(["s|job"]);
  expect(wakeSources(s, "chat", "turn").map((s) => s.value)).toEqual(["other"]);
});
