import { type CellTokenClaims, CellTokenClaimsSchema } from "@zoltbot/cloud-contracts";
import { parse } from "@zoltbot/protocol";

export const workerSecretNames = [
  "ZOLTBOT_RUNNER_TOKEN",
  "ZOLTBOT_WORKER_REFRESH",
  "ZOLTBOT_PRIVATE_CONTEXT_KEY",
  "GITHUB_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
] as const;
export type WorkerSecretName = (typeof workerSecretNames)[number];
export interface WorkerMetadata {
  orgId: string;
  taskId: string;
  memberId: string;
  runnerId: string;
  provider: "claude" | "codex";
  cellOrigin: string;
  cloudOrigin: string;
  sleepKeepsProcesses: boolean;
}
export interface WorkerEnvironment extends WorkerMetadata {
  read(name: WorkerSecretName): string | undefined;
  guard(value: unknown): void;
  rememberToken(token: string): void;
  privateValues(): readonly string[];
  clear(): void;
}
export function serviceOrigin(value: string, allowLoopback = false) {
  try {
    if (!value || value.length > 2048) throw new Error();
    const url = new URL(value);
    if (
      (url.protocol !== "https:" &&
        !(
          allowLoopback &&
          url.protocol === "http:" &&
          ["127.0.0.1", "[::1]"].includes(url.hostname)
        )) ||
      url.pathname !== "/" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error();
    return url.origin;
  } catch {
    throw new Error("worker_environment_invalid");
  }
}
function id(value: string | undefined) {
  if (!value || value.length > 200 || /[\0\r\n]/.test(value))
    throw new Error("worker_environment_invalid");
  return value;
}
/** Decoding checks injected scope only; the Cell independently verifies the ES256 signature. */
export function injectedClaims(
  token: string,
  scope: Pick<WorkerEnvironment, "orgId" | "taskId" | "memberId" | "runnerId">,
): CellTokenClaims {
  try {
    if (token.length > 8192 || /[\0\r\n]/.test(token)) throw new Error();
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some((part) => !part || !/^[A-Za-z0-9_-]+$/.test(part)))
      throw new Error();
    const header: Record<string, unknown> = JSON.parse(
      Buffer.from(parts[0] as string, "base64url").toString("utf8"),
    );
    if (header.alg !== "ES256") throw new Error();
    const claims = parse(
      CellTokenClaimsSchema,
      JSON.parse(Buffer.from(parts[1] as string, "base64url").toString("utf8")),
    );
    if (
      claims.org !== scope.orgId ||
      claims.task !== scope.taskId ||
      claims.sub !== scope.memberId ||
      claims.device !== scope.runnerId ||
      claims.kind !== "sandbox_runner" ||
      claims.surface !== "runner" ||
      claims.session !== undefined ||
      claims.grant !== undefined ||
      claims.exp <= claims.iat ||
      claims.exp - claims.iat > 600 ||
      claims.iat > Date.now() / 1000 + 30
    )
      throw new Error();
    return claims;
  } catch {
    throw new Error("worker_environment_invalid");
  }
}
/** Only recognized task values enter memory. Secrets have no enumerable properties or JSON form. */
export function readWorkerEnvironment(
  source: Record<string, string | undefined>,
  options: { allowLoopback?: boolean } = {},
): WorkerEnvironment {
  try {
    const values = new Map<WorkerSecretName, string>();
    for (const name of workerSecretNames) {
      const value = source[name];
      if (value !== undefined) {
        if (!value || value.length > 65536 || /[\0\r\n]/.test(value)) throw new Error();
        values.set(name, value);
      }
    }
    const required = (name: WorkerSecretName) => {
      const value = values.get(name);
      if (!value) throw new Error();
      return value;
    };
    const provider = source.ZOLTBOT_PROVIDER;
    if (provider !== "claude" && provider !== "codex") throw new Error();
    required(provider === "claude" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY");
    required("GITHUB_TOKEN");
    for (const name of ["ZOLTBOT_WORKER_REFRESH", "ZOLTBOT_PRIVATE_CONTEXT_KEY"] as const) {
      const value = required(name),
        bytes = Buffer.from(value, "base64url");
      const valid = bytes.length === 32 && bytes.toString("base64url") === value;
      bytes.fill(0);
      if (!valid) throw new Error();
    }
    if (!["true", "false"].includes(source.ZOLTBOT_SLEEP_KEEPS_PROCESSES ?? "")) throw new Error();
    const metadata: WorkerMetadata = {
      orgId: id(source.ZOLTBOT_ORG_ID),
      taskId: id(source.ZOLTBOT_TASK_ID),
      memberId: id(source.ZOLTBOT_MEMBER_ID),
      runnerId: id(source.ZOLTBOT_RUNNER_ID),
      provider,
      cellOrigin: serviceOrigin(source.ZOLTBOT_CELL_URL ?? "", options.allowLoopback),
      cloudOrigin: serviceOrigin(source.ZOLTBOT_CLOUD_ORIGIN ?? "", options.allowLoopback),
      sleepKeepsProcesses: source.ZOLTBOT_SLEEP_KEEPS_PROCESSES === "true",
    };
    injectedClaims(required("ZOLTBOT_RUNNER_TOKEN"), metadata);
    let closed = false;
    const privateValues = new Set(values.values());
    return Object.freeze({
      ...metadata,
      read(name: WorkerSecretName) {
        if (closed) throw new Error("worker_environment_closed");
        return values.get(name);
      },
      guard(value: unknown) {
        if (closed) throw new Error("worker_environment_closed");
        const encoded = JSON.stringify(value);
        if ([...privateValues].some((secret) => encoded?.includes(secret)))
          throw new Error("worker_private_value");
      },
      rememberToken(token: string) {
        if (closed) throw new Error("worker_environment_closed");
        injectedClaims(token, metadata);
        privateValues.add(token);
        values.set("ZOLTBOT_RUNNER_TOKEN", token);
      },
      privateValues() {
        if (closed) throw new Error("worker_environment_closed");
        return [...privateValues];
      },
      clear() {
        closed = true;
        values.clear();
        privateValues.clear();
      },
    });
  } catch {
    throw new Error("worker_environment_invalid");
  }
}
