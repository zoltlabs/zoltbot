import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import type { PrivateVault } from "../private-context.js";
import { taskVault } from "./vault.js";

function fixture() {
  const values = new Map<string, unknown>();
  const base: PrivateVault = {
    async put(value) {
      const reference = `keychain:zoltbot:${randomUUID()}`;
      values.set(reference, structuredClone(value));
      return { reference };
    },
    async read(reference) {
      return structuredClone(values.get(reference));
    },
    async replace(reference, value) {
      values.set(reference, structuredClone(value));
    },
    async remove(reference) {
      values.delete(reference);
    },
  };
  return { base, values, scope: { orgId: "org", taskId: "task" } };
}

it("reopens only the exact task's keychain envelope and refuses other tasks, orgs and Local references", async () => {
  const f = fixture(),
    vault = taskVault(f.base, f.scope);
  const { reference } = await vault.put({ values: ["Synthetic private context"] });
  expect(await taskVault(f.base, f.scope).read(reference)).toEqual({
    values: ["Synthetic private context"],
  });
  for (const scope of [
    { ...f.scope, taskId: "other" },
    { ...f.scope, orgId: "other" },
  ]) {
    await expect(taskVault(f.base, scope).read(reference)).rejects.toThrow(
      "runner_private_context_unavailable",
    );
    await expect(taskVault(f.base, scope).replace?.(reference, "Changed")).rejects.toThrow(
      "runner_private_context_unavailable",
    );
    await expect(taskVault(f.base, scope).remove?.(reference)).rejects.toThrow(
      "runner_private_context_unavailable",
    );
  }
  const local = await f.base.put("Local-only value");
  await expect(vault.read(local.reference)).rejects.toThrow("runner_private_context_unavailable");
  expect(await f.base.read(local.reference)).toBe("Local-only value");
  expect(await vault.read(reference)).toEqual({ values: ["Synthetic private context"] });
});

it("keeps the envelope binding on replacement and exposes only an opaque reference", async () => {
  const f = fixture(),
    vault = taskVault(f.base, f.scope);
  const result = await vault.put("First");
  expect(Object.keys(result)).toEqual(["reference"]);
  await vault.replace?.(result.reference, "Second");
  expect(await vault.read(result.reference)).toBe("Second");
  expect(f.values.get(result.reference)).toEqual({ version: 1, ...f.scope, value: "Second" });
  await vault.remove?.(result.reference);
  expect(f.values.has(result.reference)).toBe(false);
});

it("hides malformed envelope and keychain failure details", async () => {
  const f = fixture(),
    vault = taskVault(f.base, f.scope);
  const { reference } = await f.base.put({
    version: 1,
    ...f.scope,
    value: "Private",
    extra: "untrusted",
  });
  await expect(vault.read(reference)).rejects.toThrow("runner_private_context_unavailable");
  let calls = 0;
  const failing = taskVault(
    {
      async put() {
        throw new Error("underlying details");
      },
      async read() {
        calls++;
        throw new Error("underlying details");
      },
    },
    f.scope,
  );
  await expect(failing.put("Private")).rejects.toThrow("runner_private_context_unavailable");
  await expect(failing.read("invalid-reference")).rejects.toThrow(
    "runner_private_context_unavailable",
  );
  expect(calls).toBe(0);
  expect(failing.replace).toBeUndefined();
  expect(failing.remove).toBeUndefined();
});
