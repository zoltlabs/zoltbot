import { expect, it } from "vitest";
import { parseRunnerCommandResult } from "./command-results.js";

const diff = () => ({
  taskId: "task",
  revision: 1,
  base: "a".repeat(40),
  head: "b".repeat(40),
  patch: "",
  status: "",
  paths: ["src/main.ts"],
  files: [{ path: "src/main.ts", added: 1, removed: 0, binary: false, patch: "+content" }],
  uncommittedFiles: [],
  provenance: "Task base to working tree.",
  patchIncomplete: false,
  capturedAt: "2026-11-12T00:00:00Z",
});
it("validates bounded task-revision review and exact-commit publication results", () => {
  expect(parseRunnerCommandResult("collect_diff", diff())).toEqual(diff());
  const pushed = {
    taskId: "task",
    revision: 2,
    repository: "example/repo",
    branch: "zoltbot/task",
    head: "b".repeat(40),
    pushed: true,
  };
  expect(parseRunnerCommandResult("push_branch", pushed)).toEqual(pushed);
  expect(() => parseRunnerCommandResult("push_branch", { ...pushed, head: "HEAD" })).toThrow(
    "runner_result_invalid",
  );
  expect(() => parseRunnerCommandResult("push_branch", { ...pushed, token: "untrusted" })).toThrow(
    "runner_result_invalid",
  );
});
it.each([
  "/home/user/file",
  "../file",
  "src/../../file",
  "src/../file",
  "src/\0file",
])("refuses unsafe result path %s", (path) => {
  expect(() => parseRunnerCommandResult("collect_diff", { ...diff(), paths: [path] })).toThrow(
    "runner_result_invalid",
  );
});
it("refuses excessive entries and the aggregate UTF-8 budget even when individual strings fit", () => {
  const value = diff();
  expect(() =>
    parseRunnerCommandResult("collect_diff", {
      ...value,
      paths: Array.from({ length: 201 }, () => "file"),
    }),
  ).toThrow("runner_result_invalid");
  const patch = "界".repeat(200000);
  expect(() =>
    parseRunnerCommandResult("collect_diff", {
      ...value,
      patch,
      files: [{ ...value.files[0], patch }],
    }),
  ).toThrow("runner_result_invalid");
});
it("rejects cyclic values with a fixed error and preserves legal renamed paths", () => {
  const cycle: unknown[] = [];
  cycle.push(cycle);
  expect(() => parseRunnerCommandResult("collect_diff", cycle)).toThrow(/^runner_result_invalid$/);
  const value = diff();
  const renamed = {
    ...value,
    files: [{ ...value.files[0], path: "src/new\nname.ts", previousPath: "src/old name.ts" }],
  };
  expect(parseRunnerCommandResult("collect_diff", renamed).files[0]?.path).toBe("src/new\nname.ts");
});

it("bounds review metadata and keeps checkout paths out of commit results", () => {
  const value = {
    taskId: "task",
    revision: 1,
    fingerprint: "f".repeat(64),
    head: "b".repeat(40),
    base: "a".repeat(40),
    files: [{ path: "new.txt", hash: "c".repeat(64), mode: "100644" }],
  };
  expect(parseRunnerCommandResult("review_preview", value)).toEqual(value);
  expect(() =>
    parseRunnerCommandResult("review_preview", { ...value, cwd: "/unexpected" }),
  ).toThrow("runner_result_invalid");
  expect(() =>
    parseRunnerCommandResult("review_preview", {
      ...value,
      files: [{ ...value.files[0], mode: "777" }],
    }),
  ).toThrow("runner_result_invalid");
  const committed = {
    taskId: "task",
    revision: 1,
    fingerprint: value.fingerprint,
    head: "d".repeat(40),
    previous: value.head,
    base: value.base,
  };
  expect(parseRunnerCommandResult("review_commit", committed)).toEqual(committed);
  expect(() =>
    parseRunnerCommandResult("review_commit", { ...committed, token: "untrusted" }),
  ).toThrow("runner_result_invalid");
});
