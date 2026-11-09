import type { ConnectionDescriptor } from "./launch-manifest.js";
import type { OAuthCredential } from "./oauth.js";
import { validateDescriptor } from "./registry.js";
import { googleServiceForResource } from "./service-catalog.js";

export type NativeConnection =
  | { name: string; kind: "https"; url: string; headers: Record<string, string>; local?: true }
  | { name: string; kind: "stdio"; command: string; args: string[] };
/** Called on every open/resume, including recovery. Revoked or missing credentials fail closed. */
export async function resolveConnections(
  descriptors: readonly ConnectionDescriptor[],
  vault: { read(reference: string): Promise<unknown> },
  assertUsable: (descriptor: ConnectionDescriptor) => void,
  registerSecret: (secret: string) => void,
  googleAdapter?: (
    descriptor: ConnectionDescriptor,
    read: () => Promise<OAuthCredential>,
  ) => Promise<NativeConnection>,
): Promise<NativeConnection[]> {
  const result: NativeConnection[] = [];
  for (const descriptor of descriptors) {
    validateDescriptor(descriptor);
    assertUsable(descriptor);
    if (descriptor.transport.kind === "stdio") {
      if (descriptor.credentialReference) throw new Error("stdio_credential_mapping_required");
      result.push({ name: descriptor.name, ...descriptor.transport });
      continue;
    }
    const resource = descriptor.transport.url;
    if (
      [
        "https://gmailmcp.googleapis.com/mcp/v1",
        "https://drivemcp.googleapis.com/mcp/v1",
        "https://docsmcp.googleapis.com/mcp/v1",
      ].includes(resource)
    )
      throw new Error("connection_google_reconnect_required");
    const headers: Record<string, string> = descriptor.posthog
      ? {
          "x-posthog-project-id": descriptor.posthog.projectId,
          "x-posthog-read-only": "true",
          "x-posthog-mcp-mode": "cli",
        }
      : {};
    const readCredential = async () => {
      if (!descriptor.credentialReference) throw new Error("connection_credentials_unavailable");
      let value: OAuthCredential;
      try {
        value = (await vault.read(descriptor.credentialReference)) as OAuthCredential;
      } catch {
        throw new Error("connection_credentials_unavailable");
      }
      if (
        !value ||
        value.resource !== resource ||
        typeof value.accessToken !== "string" ||
        !value.accessToken ||
        (value.expiresAt !== undefined && value.expiresAt <= Date.now())
      )
        throw new Error("connection_credentials_unavailable");
      registerSecret(value.accessToken);
      if (value.refreshToken) registerSecret(value.refreshToken);
      return value;
    };
    if (googleServiceForResource(descriptor.transport.url)) {
      if (!googleAdapter) throw new Error("google_adapter_required");
      await readCredential();
      result.push(await googleAdapter(descriptor, readCredential));
      continue;
    }
    if (descriptor.credentialReference)
      headers.Authorization = `Bearer ${(await readCredential()).accessToken}`;
    assertUsable(descriptor);
    result.push({ name: descriptor.name, ...descriptor.transport, headers });
  }
  return result;
}
