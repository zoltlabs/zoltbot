import type { OpenOptions } from "@zoltbot/adapters-sdk";
import type { AcpFlavor } from "./flavor.js";
/** Forks are an optional draft protocol surface, never an ordinary prompt. */
export async function forkAcpSession(
  flavor: AcpFlavor,
  version: string,
  advertised: boolean,
  options: OpenOptions,
  params: { cwd: string; mcpServers: unknown[] },
  request: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>,
) {
  const policy = flavor.nativeFork;
  if (!policy || !policy.versions.includes(version) || (policy.route === "standard" && !advertised))
    throw Error("unsupported_fork");
  const source = options.fork?.sourceNativeId ?? options.nativeId;
  if (!source) throw Error("native_id_required");
  if (options.fork?.boundary.kind !== "latest") throw Error("historical_fork_unavailable");
  let result: Record<string, unknown>;
  if (policy.route === "standard")
    result = await request("session/fork", { ...params, sessionId: source });
  else {
    const created = await request("_x.ai/session/fork", {
      sourceSessionId: source,
      sourceCwd: options.fork?.sourceCwd ?? options.cwd,
      newCwd: options.cwd,
      sessionKind: "fork",
      ...(options.fork?.targetNativeId ? { newSessionId: options.fork.targetNativeId } : {}),
    });
    if (created.error) throw Error("native_fork_failed");
    const nativeId = created.newSessionId;
    if (typeof nativeId !== "string" || !nativeId || nativeId === source)
      throw Error("fork_identity_unavailable");
    result = {
      ...(await request("session/load", { ...params, sessionId: nativeId })),
      sessionId: nativeId,
    };
  }
  if (typeof result.sessionId !== "string" || !result.sessionId || result.sessionId === source)
    throw Error("fork_identity_unavailable");
  return result;
}
