import { randomUUID } from "node:crypto";

export interface KeychainRequest {
  op: "put" | "get" | "exists" | "remove" | "replace";
  account: string;
  value?: string;
}
export type KeychainTransport = (request: KeychainRequest) => Promise<unknown>;
const limit = 16384;
const referencePattern =
  /^keychain:zoltbot:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
export const isSecretReference = (value: string) => referencePattern.test(value);
function encode(value: unknown): string {
  let visited = 0;
  const valid = (entry: unknown, depth: number): boolean => {
    if (++visited > 10000 || depth > 32) return false;
    if (entry === null || typeof entry === "string" || typeof entry === "boolean") return true;
    if (typeof entry === "number") return Number.isFinite(entry);
    if (!entry || typeof entry !== "object") return false;
    if (Array.isArray(entry)) return Array.from(entry).every((part) => valid(part, depth + 1));
    if (![null, Object.prototype].includes(Object.getPrototypeOf(entry))) return false;
    return Object.values(Object.getOwnPropertyDescriptors(entry)).every(
      (descriptor) =>
        "value" in descriptor &&
        descriptor.enumerable === true &&
        valid(descriptor.value, depth + 1),
    );
  };
  if (!valid(value, 0)) throw new Error("invalid_secret_value");
  const encoded = JSON.stringify(value);
  if (typeof encoded !== "string" || Buffer.byteLength(encoded) > limit)
    throw new Error("invalid_secret_value");
  return encoded;
}
function account(reference: string) {
  const match = referencePattern.exec(reference);
  if (!match?.[1]) throw new Error("invalid_secret_reference");
  return match[1];
}
function result(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as Record<string, unknown>).ok !== true
  )
    throw new Error("keychain_unavailable");
  return value as Record<string, unknown>;
}
/** Only opaque references leave this boundary. The transport must never log its payload. */
export class KeychainSecrets {
  constructor(private readonly transport: KeychainTransport) {}
  async put(value: unknown): Promise<{ reference: string }> {
    const serialized = encode(value),
      id = randomUUID();
    try {
      result(await this.transport({ op: "put", account: id, value: serialized }));
    } catch {
      throw new Error("keychain_unavailable");
    }
    return { reference: `keychain:zoltbot:${id}` };
  }
  async read(reference: string): Promise<unknown> {
    const id = account(reference);
    try {
      const response = result(await this.transport({ op: "get", account: id }));
      if (typeof response.value !== "string" || Buffer.byteLength(response.value) > limit)
        throw new Error("keychain_unavailable");
      const value: unknown = JSON.parse(response.value);
      encode(value);
      return value;
    } catch {
      throw new Error("keychain_unavailable");
    }
  }
  async replace(reference: string, value: unknown): Promise<void> {
    const id = account(reference),
      serialized = encode(value);
    try {
      result(await this.transport({ op: "replace", account: id, value: serialized }));
    } catch {
      throw new Error("keychain_unavailable");
    }
  }
  async remove(reference: string): Promise<void> {
    const id = account(reference);
    try {
      result(await this.transport({ op: "remove", account: id }));
    } catch {
      throw new Error("keychain_unavailable");
    }
  }
  async exists(reference: string): Promise<boolean> {
    const id = account(reference);
    try {
      const response = result(await this.transport({ op: "exists", account: id }));
      if (typeof response.found !== "boolean") throw new Error("keychain_unavailable");
      return response.found;
    } catch {
      throw new Error("keychain_unavailable");
    }
  }
}
