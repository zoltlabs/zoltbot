import type { Store } from "@zoltbot/store";
import { isSecretReference } from "./secrets.js";

/** Metadata only: used by the global public-write fence, including before any session opens. */
export function connectionCredentialReferences(store: Store): { id: string; reference: string }[] {
  if (!store.database.prepare("SELECT name FROM sqlite_master WHERE name='connections_aux'").get())
    return [];
  const values: { id: string; reference: string }[] = [];
  for (const row of store.database
    .prepare("SELECT id,body FROM connections_aux ORDER BY id")
    .all() as { id: string; body: string }[]) {
    const body = JSON.parse(row.body) as { credentialReference?: unknown };
    if (body.credentialReference === undefined) continue;
    if (
      typeof body.credentialReference !== "string" ||
      !isSecretReference(body.credentialReference)
    )
      throw new Error("connection_credentials_unavailable");
    values.push({ id: row.id, reference: body.credentialReference });
  }
  return values;
}
export async function connectionPrivateValues(
  vault: { read(reference: string): Promise<unknown> },
  reference: string,
): Promise<string[]> {
  try {
    const value = (await vault.read(reference)) as {
      accessToken?: unknown;
      refreshToken?: unknown;
    };
    if (!value || typeof value.accessToken !== "string" || !value.accessToken) throw new Error();
    return [
      value.accessToken,
      ...(typeof value.refreshToken === "string" && value.refreshToken ? [value.refreshToken] : []),
    ];
  } catch {
    throw new Error("connection_credentials_unavailable");
  }
}
