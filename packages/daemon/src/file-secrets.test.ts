import { randomBytes, randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fileSecretTransport, parseSecretKey } from "./file-secrets.js";
import { KeychainSecrets } from "./secrets.js";

function folder() {
  mkdirSync(".cache/tests", { recursive: true });
  return mkdtempSync(path.resolve(".cache/tests/secrets-"));
}

describe("file secrets (D10)", () => {
  it("keeps saved logins sealed in files only the daemon's user can read", async () => {
    const dir = path.join(folder(), "secrets");
    const secrets = new KeychainSecrets(fileSecretTransport({ dir }));
    const { reference } = await secrets.put({ token: "ghp_example" });
    expect(reference).toMatch(/^keychain:zoltbot:/);
    expect(await secrets.read(reference)).toEqual({ token: "ghp_example" });
    expect(await secrets.exists(reference)).toBe(true);

    // Nothing on disk shows the value.
    for (const name of readdirSync(dir))
      expect(readFileSync(path.join(dir, name)).toString("latin1")).not.toContain("ghp_example");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(dir, "key")).mode & 0o777).toBe(0o600);

    await secrets.replace(reference, { token: "ghp_next" });
    expect(await secrets.read(reference)).toEqual({ token: "ghp_next" });
    await secrets.remove(reference);
    expect(await secrets.exists(reference)).toBe(false);
    await expect(secrets.read(reference)).rejects.toThrow("keychain_unavailable");
  });

  it("uses a key file from outside, and refuses a file swapped from another secret", async () => {
    const root = folder();
    const keyFile = path.join(root, "zoltbot.key");
    writeFileSync(keyFile, randomBytes(32).toString("base64"));
    const dir = path.join(root, "secrets");
    const secrets = new KeychainSecrets(fileSecretTransport({ dir, keyFile }));
    const one = await secrets.put("one");
    const two = await secrets.put("two");
    expect(readdirSync(dir)).not.toContain("key");

    const id = (reference: string) => reference.split(":").at(-1);
    writeFileSync(
      path.join(dir, `${id(two.reference)}.secret`),
      readFileSync(path.join(dir, `${id(one.reference)}.secret`)),
    );
    await expect(secrets.read(two.reference)).rejects.toThrow("keychain_unavailable");

    // Another key can't open them.
    writeFileSync(keyFile, randomBytes(32).toString("hex"));
    const other = new KeychainSecrets(fileSecretTransport({ dir, keyFile }));
    await expect(other.read(one.reference)).rejects.toThrow("keychain_unavailable");
  });

  it("reads keys as raw bytes, hex or base64, and rejects others", async () => {
    const key = randomBytes(32);
    expect(() => parseSecretKey(key)).toThrow("secret_key_invalid");
    expect(() => parseSecretKey(Buffer.from("a passphrase of thirty-two chars"))).toThrow(
      "secret_key_invalid",
    );
    expect(parseSecretKey(Buffer.from(key.toString("hex")))).toEqual(key);
    expect(parseSecretKey(Buffer.from(`${key.toString("base64")}\n`))).toEqual(key);
    expect(() => parseSecretKey(Buffer.from("short"))).toThrow("secret_key_invalid");
    const transport = fileSecretTransport({ dir: path.join(folder(), "s") });
    expect(await transport({ op: "get", account: "../../etc/passwd" })).toEqual({ ok: false });
    expect(await transport({ op: "exists", account: randomUUID() })).toEqual({
      ok: true,
      found: false,
    });
  });
});
