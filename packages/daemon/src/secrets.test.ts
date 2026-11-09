import { expect, it } from "vitest";
import { KeychainSecrets } from "./secrets.js";

it("stores an opaque keychain reference and restores the exact private value through its bounded transport", async () => {
  const values = new Map<string, string>();
  const vault = new KeychainSecrets(async (request) => {
    if (request.op === "put") {
      values.set(request.account, request.value ?? "");
      return { ok: true };
    }
    if (request.op === "exists") return { ok: true, found: values.has(request.account) };
    return { ok: true, value: values.get(request.account) };
  });
  const value = { value: "synthetic-private-keychain-value", enabled: false };
  const first = await vault.put(value),
    second = await vault.put(value);
  expect(first.reference).toMatch(/^keychain:zoltbot:[0-9a-f-]{36}$/);
  expect(first.reference).not.toBe(second.reference);
  expect(JSON.stringify(first)).not.toContain(value.value);
  expect(await vault.exists(first.reference)).toBe(true);
  expect(await vault.read(first.reference)).toEqual(value);
  expect(await vault.exists("keychain:zoltbot:00000000-0000-4000-8000-000000000000")).toBe(false);
});

it("rejects invalid references and oversized or unsupported values before invoking Keychain", async () => {
  let calls = 0;
  const vault = new KeychainSecrets(async () => {
    calls++;
    return { ok: true };
  });
  for (const reference of ["keychain:other", "../../other", "keychain:zoltbot:not-a-uuid"])
    await expect(vault.read(reference)).rejects.toThrow("invalid_secret_reference");
  for (const value of [undefined, Number.NaN, { value: undefined }, "x".repeat(16385)])
    await expect(vault.put(value)).rejects.toThrow("invalid_secret_value");
  expect(calls).toBe(0);
});

it("masks failed or malformed helper responses and never substitutes an empty secret", async () => {
  const reference = "keychain:zoltbot:00000000-0000-4000-8000-000000000000";
  for (const response of [
    { ok: false, detail: "synthetic-private-helper-error" },
    { ok: true },
    { ok: true, value: "not-json" },
  ]) {
    const vault = new KeychainSecrets(async () => response);
    await expect(vault.read(reference)).rejects.toThrow("keychain_unavailable");
  }
  const vault = new KeychainSecrets(async () => {
    throw new Error("synthetic-private-helper-error");
  });
  await expect(vault.put("synthetic-private-value")).rejects.toThrow(/^keychain_unavailable$/);
});
