import path from "node:path";
import type Database from "better-sqlite3";
import type { ConnectionDescriptor } from "./launch-manifest.js";

export interface ConnectionRecord extends ConnectionDescriptor {
  source: string;
  executionApproved?: boolean;
  revokedThroughVersion?: number;
  enabled: boolean;
  profileIds: string[];
  credentialStatus: "not_required" | "needs_sign_in" | "connected";
  health: "not_checked" | "healthy" | "unavailable";
  checkedAt?: string;
}
const reference = /^keychain:zoltbot:[0-9a-f-]{36}$/;
export function validateDescriptor(value: ConnectionDescriptor) {
  if (
    !/^[a-zA-Z0-9_-]{1,100}$/.test(value.id) ||
    !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(value.name) ||
    value.name === "zoltbot" ||
    !value.projectId ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1
  )
    throw new Error("invalid_connection_descriptor");
  if (
    value.posthog &&
    (value.transport.kind !== "https" ||
      value.transport.url !== "https://mcp.posthog.com/mcp" ||
      !/^[1-9][0-9]{0,19}$/.test(value.posthog.projectId))
  )
    throw new Error("connection_posthog_project_invalid");
  if (value.credentialReference && !reference.test(value.credentialReference))
    throw new Error("invalid_credential_reference");
  if (!Number.isSafeInteger(value.schemaTokens.value) || value.schemaTokens.value < 0)
    throw new Error("invalid_schema_estimate");
  if (value.transport.kind === "https") {
    const url = new URL(value.transport.url);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
      throw new Error("invalid_connection_url");
  } else {
    if (
      !path.isAbsolute(value.transport.command) ||
      value.transport.command.includes("\0") ||
      value.transport.args.some((arg) => arg.includes("\0"))
    )
      throw new Error("invalid_connection_command");
  }
}
/** Metadata only. Never accepts raw tokens or environment values. */
export class ConnectionRegistry {
  constructor(private readonly db: Database.Database) {}
  list(projectId?: string): ConnectionRecord[] {
    const rows = projectId
      ? this.db
          .prepare("SELECT body FROM connections_aux WHERE project_id=? ORDER BY id")
          .all(projectId)
      : this.db.prepare("SELECT body FROM connections_aux ORDER BY id").all();
    return (rows as { body: string }[]).map((r) => JSON.parse(r.body));
  }
  get(id: string): ConnectionRecord {
    const row = this.db.prepare("SELECT body FROM connections_aux WHERE id=?").get(id) as
      | { body: string }
      | undefined;
    if (!row) throw new Error("connection_not_found");
    return JSON.parse(row.body);
  }
  save(value: ConnectionRecord, expectedVersion: number, confirmed = false): ConnectionRecord {
    validateDescriptor(value);
    if (value.enabled && value.transport.kind === "stdio" && !value.executionApproved)
      throw new Error("connection_execution_confirmation_required");
    // Whitelist fields so unknown caller properties cannot persist secrets.
    const body: ConnectionRecord = {
      id: value.id,
      name: value.name,
      projectId: value.projectId,
      version: expectedVersion + 1,
      transport:
        value.transport.kind === "https"
          ? { kind: "https", url: value.transport.url }
          : { kind: "stdio", command: value.transport.command, args: [...value.transport.args] },
      schemaTokens: { value: value.schemaTokens.value, source: value.schemaTokens.source },
      source: value.source,
      ...(value.posthog ? { posthog: { projectId: value.posthog.projectId } } : {}),
      ...(value.executionApproved ? { executionApproved: true } : {}),
      enabled: value.enabled,
      profileIds: [...new Set(value.profileIds)],
      credentialStatus: value.credentialStatus,
      health: value.health,
      ...(value.credentialReference ? { credentialReference: value.credentialReference } : {}),
      ...(value.checkedAt ? { checkedAt: value.checkedAt } : {}),
    };
    return this.db
      .transaction(() => {
        const row = this.db.prepare("SELECT body FROM connections_aux WHERE id=?").get(value.id) as
          | { body: string }
          | undefined;
        const prior: ConnectionRecord | undefined = row ? JSON.parse(row.body) : undefined;
        if ((prior?.version ?? 0) !== expectedVersion)
          throw new Error("connection_version_conflict");
        if (prior && prior.projectId !== value.projectId)
          throw new Error("connection_scope_immutable");
        if (prior?.revokedThroughVersion || value.revokedThroughVersion)
          body.revokedThroughVersion = Math.max(
            prior?.revokedThroughVersion ?? 0,
            value.revokedThroughVersion ?? 0,
          );
        const widens =
          (body.enabled && !prior?.enabled) ||
          body.profileIds.some((id) => !prior?.profileIds.includes(id));
        if (widens && !confirmed) throw new Error("connection_access_confirmation_required");
        this.db
          .prepare(
            "INSERT INTO connections_aux(id,project_id,body) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
          )
          .run(body.id, body.projectId, JSON.stringify(body));
        this.db
          .prepare("INSERT INTO connection_audit_aux(connection_id,action,version) VALUES(?,?,?)")
          .run(body.id, widens ? "access_confirmed" : "updated", body.version);
        return body;
      })
      .immediate();
  }
  /** Observed health is not a new launch configuration. */
  recordHealth(
    id: string,
    expectedVersion: number,
    health: ConnectionRecord["health"],
    checkedAt: string,
  ) {
    return this.db
      .transaction(() => {
        const current = this.get(id);
        if (current.version !== expectedVersion) throw new Error("connection_version_conflict");
        this.db
          .prepare("UPDATE connections_aux SET body=? WHERE id=?")
          .run(JSON.stringify({ ...current, health, checkedAt }), id);
      })
      .immediate();
  }
  effective(
    projectId: string | undefined,
    profileId: string,
    supported: boolean,
  ): ConnectionDescriptor[] {
    if (!projectId || !supported) return [];
    return this.list(projectId)
      .filter(
        (c) =>
          c.enabled &&
          c.profileIds.includes(profileId) &&
          c.credentialStatus !== "needs_sign_in" &&
          (c.transport.kind !== "stdio" || c.executionApproved === true),
      )
      .map((c) => ({
        id: c.id,
        name: c.name,
        projectId: c.projectId,
        version: c.version,
        transport: c.transport,
        schemaTokens: c.schemaTokens,
        ...(c.posthog ? { posthog: { ...c.posthog } } : {}),
        ...(c.credentialReference ? { credentialReference: c.credentialReference } : {}),
      }));
  }
  assertUsable(descriptor: ConnectionDescriptor) {
    const current = this.get(descriptor.id);
    // Edits preserve the frozen descriptor; revocation blocks even a resumed session.
    if (
      descriptor.version <= (current.revokedThroughVersion ?? 0) ||
      current.projectId !== descriptor.projectId ||
      current.credentialStatus === "needs_sign_in" ||
      current.credentialReference !== descriptor.credentialReference
    )
      throw new Error("connection_revoked");
  }
}
