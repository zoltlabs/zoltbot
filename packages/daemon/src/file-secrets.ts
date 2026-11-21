// D10: saved logins on a Linux server, which has no keychain. Each secret is a file in its own
// folder, sealed with AES-256-GCM under a key kept apart from Zoltbot's data folder (a systemd
// credential or a container secret). The store and the event log still hold only references.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { KeychainRequest, KeychainTransport } from "./secrets.js";

const ACCOUNT = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEY_BYTES = 32;

/**
 * Reads a 32-byte key written as 64 hex characters or as base64. Raw bytes and passphrases are
 * refused, so a short typed phrase can't pass for a key.
 */
export function parseSecretKey(bytes: Buffer): Buffer {
  const text = bytes.toString("utf8").trim();
  if (/^[0-9a-f]{64}$/i.test(text)) return Buffer.from(text, "hex");
  if (/^[A-Za-z0-9+/]{43}=$/.test(text)) return Buffer.from(text, "base64");
  throw new Error("secret_key_invalid: the key must be 32 bytes, as hex or base64");
}

/**
 * The key: from `keyFile` when given (it must exist), otherwise `<dir>/key`, made on first use.
 * Keeping the key in the same folder only protects against reading the data folder; a server
 * should pass a key file from systemd's LoadCredential or a container secret.
 */
async function loadKey(dir: string, keyFile?: string): Promise<Buffer> {
  if (keyFile) return parseSecretKey(await readFile(keyFile));
  const file = path.join(dir, "key");
  if (!existsSync(file)) {
    // Two daemons starting at once: the second keeps the first one's key.
    await writeFile(file, randomBytes(KEY_BYTES).toString("hex"), {
      mode: 0o600,
      flag: "wx",
    }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
  }
  return parseSecretKey(await readFile(file));
}

function seal(key: Buffer, account: string, value: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  // The account is bound in, so a file can't be swapped for another secret's.
  cipher.setAAD(Buffer.from(account));
  const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), body]);
}

function open(key: Buffer, account: string, sealed: Buffer): string {
  if (sealed[0] !== 1 || sealed.length < 29) throw new Error("secret_unreadable");
  const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(1, 13));
  decipher.setAAD(Buffer.from(account));
  decipher.setAuthTag(sealed.subarray(13, 29));
  return Buffer.concat([decipher.update(sealed.subarray(29)), decipher.final()]).toString("utf8");
}

/** A keychain made of sealed files in `dir`, which only the daemon's user can read. */
export function fileSecretTransport(options: { dir: string; keyFile?: string }): KeychainTransport {
  let key: Promise<Buffer> | undefined;
  const ready = async () => {
    await mkdir(options.dir, { recursive: true, mode: 0o700 });
    await chmod(options.dir, 0o700);
    // A failure isn't kept: the next request tries again, for example once the key is readable.
    key ??= loadKey(options.dir, options.keyFile).catch((error) => {
      key = undefined;
      throw error;
    });
    return key;
  };
  const file = (account: string) => path.join(options.dir, `${account}.secret`);
  const write = async (account: string, value: string) => {
    const target = file(account);
    const pending = `${target}.${randomBytes(6).toString("hex")}.pending`;
    try {
      await writeFile(pending, seal(await ready(), account, value), { mode: 0o600, flag: "wx" });
      await rename(pending, target);
    } finally {
      await rm(pending, { force: true });
    }
  };
  return async (request: KeychainRequest) => {
    if (!ACCOUNT.test(request.account)) return { ok: false };
    const secret = await ready();
    switch (request.op) {
      case "put":
        if (typeof request.value !== "string" || existsSync(file(request.account)))
          return { ok: false };
        await write(request.account, request.value);
        return { ok: true };
      case "replace":
        if (typeof request.value !== "string" || !existsSync(file(request.account)))
          return { ok: false };
        await write(request.account, request.value);
        return { ok: true };
      case "get":
        return {
          ok: true,
          value: open(secret, request.account, await readFile(file(request.account))),
        };
      case "exists":
        return { ok: true, found: existsSync(file(request.account)) };
      case "remove":
        await rm(file(request.account), { force: true });
        return { ok: true };
      default:
        return { ok: false };
    }
  };
}
