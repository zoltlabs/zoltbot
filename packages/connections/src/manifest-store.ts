import type Database from "better-sqlite3";
import type { LaunchManifest } from "./launch-manifest.js";

/** The caller's intent transaction may include task/session writes on the same database. */
export class LaunchManifestStore {
  constructor(private readonly db: Database.Database) {}
  prepare(manifest: LaunchManifest, validate: () => void): LaunchManifest {
    return this.db
      .transaction(() => {
        const prior = this.byExecution(manifest.executionId);
        if (prior) return prior; // retry must retain the original native launch inputs
        validate();
        this.db
          .prepare("INSERT INTO launch_manifests_aux(id,execution_id,body) VALUES(?,?,?)")
          .run(manifest.id, manifest.executionId, JSON.stringify(manifest));
        return structuredClone(manifest);
      })
      .immediate();
  }
  byExecution(executionId: string): LaunchManifest | undefined {
    const row = this.db
      .prepare("SELECT body FROM launch_manifests_aux WHERE execution_id=?")
      .get(executionId) as { body: string } | undefined;
    return row ? JSON.parse(row.body) : undefined;
  }
  bind(id: string, nativeId: string) {
    const result = this.db
      .prepare(
        "UPDATE launch_manifests_aux SET native_id=?,state='bound' WHERE id=? AND state IN ('prepared','bound') AND (native_id IS NULL OR native_id=?)",
      )
      .run(nativeId, id, nativeId);
    if (result.changes !== 1) throw new Error("launch_manifest_binding_conflict");
  }
}
