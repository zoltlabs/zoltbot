import { createHash } from "node:crypto";
import type { ConnectionRegistry } from "./registry.js";

/** Imported references remain disabled and unresolved. Never inspect env or file references. */
export function importConnectionMetadata(
  registry: ConnectionRegistry,
  entries: readonly Record<string, unknown>[],
  projectId: string,
) {
  const imported: string[] = [];
  for (const entry of entries) {
    const config = entry.configuration as Record<string, unknown> | undefined;
    if (!config || typeof config.url !== "string") continue;
    let url: URL;
    try {
      url = new URL(config.url);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
      continue;
    const source = String(entry.source ?? "imported");
    const identity = JSON.stringify([
      source,
      entry.nativePath,
      entry.scopePath,
      entry.name,
      projectId,
    ]);
    const id = `import-${createHash("sha256").update(identity).digest("hex").slice(0, 32)}`;
    if (String(entry.name) === "zoltbot") continue;
    if (registry.list(projectId).some((c) => c.id === id)) continue;
    const name = String(entry.name ?? "imported")
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .slice(0, 55);
    registry.save(
      {
        id,
        name: /^[a-zA-Z]/.test(name) ? name : `import_${name}`,
        projectId,
        version: 1,
        transport: { kind: "https", url: url.toString() },
        source: `${source} · references not resolved`,
        enabled: false,
        profileIds: [],
        credentialStatus: "needs_sign_in",
        health: "not_checked",
        schemaTokens: { value: 512, source: "estimated" },
      },
      0,
    );
    imported.push(id);
  }
  return imported;
}
