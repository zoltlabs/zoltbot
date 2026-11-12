import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  copyFile,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { EncryptedTaskVault } from "./encrypted-vault.js";

const roots: string[] = [],
  vaults: EncryptedTaskVault[] = [];
afterEach(async () => {
  for (const vault of vaults.splice(0)) vault.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "zoltbot-encrypted-task-vault-"));
  roots.push(root);
  const directory = path.join(root, "vault"),
    scope = { orgId: "org", taskId: "task" };
  const key = randomBytes(32).toString("base64url");
  const open = (input = { directory, scope, key }) => {
    const vault = new EncryptedTaskVault(input.directory, input.scope, input.key);
    vaults.push(vault);
    return vault;
  };
  const file = (reference: string) =>
    path.join(directory, `${createHash("sha256").update(reference).digest("hex")}.json`);
  return { root, directory, scope, key, open, file };
}

it("persists only ciphertext and reopens the original private context with the injected task key", async () => {
  const f = await fixture(),
    vault = f.open(),
    value = randomBytes(32).toString("base64url");
  const { reference } = await vault.put({ version: 1, hideFrames: true, values: [value] });
  const bytes = await readFile(f.file(reference));
  expect(bytes.includes(Buffer.from(value))).toBe(false);
  expect(bytes.includes(Buffer.from(f.key))).toBe(false);
  expect(bytes.includes(Buffer.from(f.key, "base64url"))).toBe(false);
  expect((await stat(f.file(reference))).mode & 0o777).toBe(0o600);
  expect((await stat(f.directory)).mode & 0o777).toBe(0o700);
  vault.close();
  expect(await f.open().read(reference)).toEqual({ version: 1, hideFrames: true, values: [value] });
  await expect(vault.read(reference)).rejects.toThrow("runner_private_context_unavailable");
});

it("uses a fresh authenticated envelope on replace and durably removes only its own reference", async () => {
  const f = await fixture(),
    vault = f.open(),
    { reference } = await vault.put("First");
  const first = JSON.parse(await readFile(f.file(reference), "utf8"));
  await vault.replace(reference, "Second");
  const second = JSON.parse(await readFile(f.file(reference), "utf8"));
  expect(first.nonce).not.toBe(second.nonce);
  expect(first.ciphertext).not.toBe(second.ciphertext);
  expect(await f.open().read(reference)).toBe("Second");
  await vault.remove(reference);
  expect(await readdir(f.directory)).toEqual([]);
  await expect(vault.read(reference)).rejects.toThrow("runner_private_context_unavailable");
});

it("refuses ciphertext moved to a different org, task, reference or key", async () => {
  const f = await fixture(),
    vault = f.open(),
    { reference } = await vault.put("Bound context");
  for (const input of [
    { directory: f.directory, scope: { ...f.scope, orgId: "other" }, key: f.key },
    { directory: f.directory, scope: { ...f.scope, taskId: "other" }, key: f.key },
    { directory: f.directory, scope: f.scope, key: randomBytes(32).toString("base64url") },
  ]) {
    const other = f.open(input);
    await expect(other.read(reference)).rejects.toThrow("runner_private_context_unavailable");
    await expect(other.replace(reference, "Changed")).rejects.toThrow(
      "runner_private_context_unavailable",
    );
    await expect(other.remove(reference)).rejects.toThrow("runner_private_context_unavailable");
  }
  const otherReference = `keychain:zoltbot:${randomUUID()}`;
  await copyFile(f.file(reference), f.file(otherReference));
  await expect(vault.read(otherReference)).rejects.toThrow("runner_private_context_unavailable");
  expect(await vault.read(reference)).toBe("Bound context");
});

it("refuses authentication-tag tampering, symlink files and symlink roots", async () => {
  const f = await fixture(),
    vault = f.open(),
    { reference } = await vault.put("Private context");
  const file = f.file(reference),
    original = await readFile(file, "utf8"),
    envelope = JSON.parse(original);
  const tag = Buffer.from(envelope.tag, "base64url");
  tag[0] = (tag[0] ?? 0) ^ 1;
  envelope.tag = tag.toString("base64url");
  await writeFile(file, JSON.stringify(envelope));
  await expect(vault.read(reference)).rejects.toThrow("runner_private_context_unavailable");
  await writeFile(file, original);
  const saved = path.join(f.root, "saved-envelope.json");
  await rename(file, saved);
  await symlink(saved, file);
  await expect(vault.read(reference)).rejects.toThrow("runner_private_context_unavailable");
  await rm(file);
  await rename(saved, file);
  const linked = path.join(f.root, "linked");
  await symlink(f.directory, linked);
  await expect(
    f.open({ directory: linked, scope: f.scope, key: f.key }).read(reference),
  ).rejects.toThrow("runner_private_context_unavailable");
});

it("bounds serialized values and file reads and never evaluates object getters", async () => {
  const f = await fixture(),
    vault = f.open();
  await expect(vault.put("x".repeat(16385))).rejects.toThrow("runner_private_context_unavailable");
  let calls = 0;
  const getter = Object.defineProperty({}, "value", {
    enumerable: true,
    get() {
      calls++;
      return "unexpected";
    },
  });
  await expect(vault.put(getter)).rejects.toThrow("runner_private_context_unavailable");
  expect(calls).toBe(0);
  expect(await readdir(f.directory)).toEqual([]);
  const { reference } = await vault.put("Bounded");
  await writeFile(f.file(reference), "x".repeat(40001));
  await expect(vault.read(reference)).rejects.toThrow("runner_private_context_unavailable");
  await expect(vault.read("invalid-reference")).rejects.toThrow(
    "runner_private_context_unavailable",
  );
  expect(() => f.open({ directory: f.directory, scope: f.scope, key: "invalid" })).toThrow(
    "runner_private_context_unavailable",
  );
});
