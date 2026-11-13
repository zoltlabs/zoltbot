import { expect, it } from "vitest";
import { workerPaths } from "./paths.js";

it("keeps template paths unchanged and lets isolated headless hosts select their own worker home", () => {
  expect(workerPaths({})).toEqual({
    directory: "/home/user/.zoltbot",
    workDirectory: "/home/user/work",
  });
  expect(workerPaths({ ZOLTBOT_WORKER_HOME: "/tmp/zoltbot-sandbox" })).toEqual({
    directory: "/tmp/zoltbot-sandbox/.zoltbot",
    workDirectory: "/tmp/zoltbot-sandbox/work",
  });
});
it("refuses invalid or ambiguous deployment paths before worker startup", () => {
  for (const value of [
    "",
    ".",
    "relative/home",
    "/",
    "/tmp/../tmp/work",
    "/tmp/root\nother",
    "/tmp/root\0other",
  ])
    expect(() => workerPaths({ ZOLTBOT_WORKER_HOME: value })).toThrow(/^worker_paths_invalid$/);
});
