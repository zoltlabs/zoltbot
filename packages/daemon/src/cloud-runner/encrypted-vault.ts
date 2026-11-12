import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import type { PrivateVault } from "../private-context.js";
import { isSecretReference } from "../secrets.js";
import type { TaskVaultScope } from "./vault.js";

function encode(value: unknown): Buffer {
  let count = 0;
  const valid = (entry: unknown, depth: number): boolean => {
    if (++count > 10000 || depth > 32) return false;
    if (entry === null || typeof entry === "string" || typeof entry === "boolean") return true;
    if (typeof entry === "number") return Number.isFinite(entry);
    if (!entry || typeof entry !== "object") return false;
    if (Array.isArray(entry)) return Array.from(entry).every((part) => valid(part, depth + 1));
    if (![null, Object.prototype].includes(Object.getPrototypeOf(entry))) return false;
    return Object.values(Object.getOwnPropertyDescriptors(entry)).every(
      (descriptor) =>
        "value" in descriptor && descriptor.enumerable && valid(descriptor.value, depth + 1),
    );
  };
  if (!valid(value, 0)) throw new Error("runner_private_context_unavailable");
  const encoded = Buffer.from(JSON.stringify(value));
  if (encoded.length > 16384) {
    encoded.fill(0);
    throw new Error("runner_private_context_unavailable");
  }
  return encoded;
}
function decoded(value: unknown, length?: number): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value || (length !== undefined && bytes.length !== length)) {
    bytes.fill(0);
    throw new Error();
  }
  return bytes;
}

/** Sandbox persistence contains ciphertext only. The task key is injected through the environment. */
export class EncryptedTaskVault implements PrivateVault {
  private readonly scope: TaskVaultScope;
  private readonly key: Buffer;
  private closed = false;
  constructor(
    private readonly directory: string,
    source: TaskVaultScope,
    environmentKey: string,
  ) {
    try {
      if (!path.isAbsolute(directory) || !source.orgId || !source.taskId) throw new Error();
      this.scope = structuredClone(source);
      this.key = decoded(environmentKey, 32);
    } catch {
      throw new Error("runner_private_context_unavailable");
    }
  }
  private check() {
    if (this.closed) throw new Error("runner_private_context_unavailable");
  }
  private aad(reference: string) {
    if (!isSecretReference(reference)) throw new Error("runner_private_context_unavailable");
    return Buffer.from(JSON.stringify([1, this.scope.orgId, this.scope.taskId, reference]));
  }
  private async file(reference: string) {
    this.check();
    this.aad(reference);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error();
    await chmod(this.directory, 0o700);
    const root = await realpath(this.directory);
    return {
      root,
      file: path.join(root, `${createHash("sha256").update(reference).digest("hex")}.json`),
    };
  }
  async put(value: unknown) {
    const reference = `keychain:zoltbot:${randomUUID()}`;
    await this.write(reference, value, true);
    return { reference };
  }
  private async write(reference: string, value: unknown, fresh: boolean) {
    let plaintext: Buffer | undefined, temporary: string | undefined;
    try {
      this.check();
      const target = await this.file(reference);
      if (!fresh) await this.read(reference);
      this.check();
      plaintext = encode(value);
      const nonce = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", this.key, nonce);
      cipher.setAAD(this.aad(reference));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const envelope = JSON.stringify({
        version: 1,
        nonce: nonce.toString("base64url"),
        ciphertext: ciphertext.toString("base64url"),
        tag: cipher.getAuthTag().toString("base64url"),
      });
      temporary = path.join(target.root, `write-${randomUUID()}.tmp`);
      const descriptor = await open(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await descriptor.writeFile(envelope);
        await descriptor.sync();
      } finally {
        await descriptor.close();
      }
      this.check();
      await rename(temporary, target.file);
      temporary = undefined;
      const directory = await open(target.root, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch {
      throw new Error("runner_private_context_unavailable");
    } finally {
      plaintext?.fill(0);
      if (temporary) await unlink(temporary).catch(() => {});
    }
  }
  async read(reference: string): Promise<unknown> {
    let plaintext: Buffer | undefined;
    try {
      const target = await this.file(reference);
      const descriptor = await open(target.file, constants.O_RDONLY | constants.O_NOFOLLOW);
      let envelope: Record<string, unknown>;
      try {
        const info = await descriptor.stat();
        if (!info.isFile() || info.nlink !== 1 || info.size > 40000) throw new Error();
        const encoded = Buffer.alloc(40001);
        let size = 0;
        while (size < encoded.length) {
          const read = await descriptor.read(encoded, size, encoded.length - size, size);
          if (read.bytesRead === 0) break;
          size += read.bytesRead;
        }
        if (size > 40000) throw new Error();
        envelope = JSON.parse(encoded.subarray(0, size).toString("utf8"));
      } finally {
        await descriptor.close();
      }
      if (
        !envelope ||
        typeof envelope !== "object" ||
        Array.isArray(envelope) ||
        envelope.version !== 1 ||
        Object.keys(envelope).sort().join(",") !== "ciphertext,nonce,tag,version"
      )
        throw new Error();
      const ciphertext = decoded(envelope.ciphertext);
      if (ciphertext.length > 16384) throw new Error();
      this.check();
      const decipher = createDecipheriv("aes-256-gcm", this.key, decoded(envelope.nonce, 12));
      decipher.setAAD(this.aad(reference));
      decipher.setAuthTag(decoded(envelope.tag, 16));
      const partial = decipher.update(ciphertext);
      let final: Buffer | undefined;
      try {
        final = decipher.final();
        plaintext = Buffer.concat([partial, final]);
      } finally {
        partial.fill(0);
        final?.fill(0);
      }
      const result: unknown = JSON.parse(plaintext.toString("utf8"));
      const check = encode(result);
      check.fill(0);
      return result;
    } catch {
      throw new Error("runner_private_context_unavailable");
    } finally {
      plaintext?.fill(0);
    }
  }
  async replace(reference: string, value: unknown) {
    await this.write(reference, value, false);
  }
  async remove(reference: string) {
    try {
      await this.read(reference);
      const target = await this.file(reference);
      this.check();
      await unlink(target.file);
      const directory = await open(target.root, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch {
      throw new Error("runner_private_context_unavailable");
    }
  }
  close() {
    this.closed = true;
    this.key.fill(0);
  }
}
