import type { DomainState } from "@zoltbot/core";
import { type AgentDefinition, AgentDefinitionSchema, parse } from "@zoltbot/protocol";
import { assertPublicDefinition } from "./definition-configuration.js";
import type { Redactor } from "./logging.js";
import type { PrivateVault } from "./private-context.js";
import { isSecretReference } from "./secrets.js";

export function protectedCredentialReferences(state: DomainState): [string, string, string][] {
  const result: [string, string, string][] = [];
  for (const row of state.agentDefinition ?? []) {
    const launch = row.launch as { env?: unknown } | undefined;
    if (!launch?.env || typeof launch.env !== "object" || Array.isArray(launch.env)) continue;
    for (const [name, value] of Object.entries(launch.env))
      if (typeof value === "string" && isSecretReference(value))
        result.push([String(row.id), name, value]);
  }
  return result.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
export async function readRuntimeCredential(
  vault: Pick<PrivateVault, "read">,
  reference: string,
): Promise<string> {
  try {
    const value = await vault.read(reference);
    if (
      typeof value !== "string" ||
      !value ||
      value.includes("\0") ||
      Buffer.byteLength(value) > 16384
    )
      throw new Error("runtime_credentials_unavailable");
    return value;
  } catch {
    throw new Error("runtime_credentials_unavailable");
  }
}

/** Ephemeral launch configuration. Never persist or return this definition through a public API. */
export async function resolveRuntimeCredentials(
  definition: AgentDefinition,
  vault: Pick<PrivateVault, "read"> | undefined,
  redactor: Redactor,
): Promise<{ definition: AgentDefinition; privateValues?: readonly string[] }> {
  const stable = parse(AgentDefinitionSchema, structuredClone(definition));
  assertPublicDefinition(stable);
  const argumentsToCheck = [
    stable.launch.command,
    ...stable.launch.args,
    ...stable.versionCommand,
    ...(stable.auth?.statusCommand ?? []),
    ...(stable.auth?.loginCommand ?? []),
  ];
  if (argumentsToCheck.some(isSecretReference))
    throw new Error("runtime_credential_location_unsupported");
  const references = [...new Set(Object.values(stable.launch.env).filter(isSecretReference))];
  if (!references.length) return { definition: stable };
  if (!vault) throw new Error("runtime_credentials_unavailable");
  const resolved = new Map<string, string>();
  try {
    await Promise.all(
      references.map(async (reference) => {
        const value = await readRuntimeCredential(vault, reference);
        redactor.register(value);
        redactor.hideFrames();
        resolved.set(reference, value);
      }),
    );
    const privateValues = [...new Set(resolved.values())];
    if (Buffer.byteLength(JSON.stringify(privateValues)) > 16384)
      throw new Error("runtime_credentials_unavailable");
    stable.launch.env = Object.fromEntries(
      Object.entries(stable.launch.env).map(([key, value]) => [key, resolved.get(value) ?? value]),
    );
    return { definition: stable, privateValues };
  } catch {
    throw new Error("runtime_credentials_unavailable");
  }
}
