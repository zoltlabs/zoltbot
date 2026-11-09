import { expect, it } from "vitest";
import { NativeSessionIndex } from "./native-sessions.js";

it("coalesces scans and rate limits focus without suppressing explicit refresh", async () => {
  let calls = 0,
    commits = 0,
    now = 1000;
  const index = new NativeSessionIndex({
    now: () => now,
    list: async () => {
      calls++;
      await Promise.resolve();
      return [];
    },
    commit: async () => {
      commits++;
    },
  });
  await Promise.all([index.refresh("codex", "focus"), index.refresh("codex", "focus")]);
  expect([calls, commits]).toEqual([1, 1]);
  await index.refresh("codex", "focus");
  expect(calls).toBe(1);
  await index.refresh("codex", "panel");
  expect(calls).toBe(2);
  now += 30000;
  await index.refresh("codex", "focus");
  expect(calls).toBe(3);
});
it("never commits a failed listing and allows immediate retry", async () => {
  let calls = 0,
    commits = 0;
  const index = new NativeSessionIndex({
    list: async () => {
      if (++calls === 1) throw new Error("listing_failed");
      return [];
    },
    commit: async () => {
      commits++;
    },
  });
  await expect(index.refresh("codex", "focus")).rejects.toThrow("listing_failed");
  expect(commits).toBe(0);
  await index.refresh("codex", "focus");
  expect(commits).toBe(1);
});
it("keeps provider and folder scan identities independent", async () => {
  const calls: string[] = [];
  const index = new NativeSessionIndex({
    list: async (provider, filter) => {
      calls.push(`${provider}:${filter.cwd}`);
      return [];
    },
    commit: async () => {},
  });
  await index.refresh("codex", "focus", { cwd: "/one" });
  await index.refresh("codex", "focus", { cwd: "/two" });
  await index.refresh("pi", "focus", { cwd: "/one" });
  expect(calls).toEqual(["codex:/one", "codex:/two", "pi:/one"]);
});
