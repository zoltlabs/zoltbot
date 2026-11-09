import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { parseSkill, type SkillBundle } from "./parser.js";

export interface SkillEntry {
  id: string;
  name: string;
  current_revision: number;
  source: string | null;
  source_hash: string | null;
  removed: number;
}
export interface SkillRevision {
  skillId: string;
  revision: number;
  bundle: SkillBundle;
  createdAt: string;
}
export interface SkillSelection {
  skillId: string;
  revision: number;
  name: string;
  hash: string;
  installedPath?: string;
  reportedLoaded?: boolean;
}
export interface SkillSnapshot {
  manifestId: string;
  profileId: string;
  scopeId: string;
  skills: SkillSelection[];
}
export class SkillsLibrary {
  constructor(readonly db: Database.Database) {}
  list(): SkillEntry[] {
    return this.db
      .prepare("SELECT * FROM skill_library WHERE removed=0 ORDER BY name,id")
      .all() as SkillEntry[];
  }
  get(id: string): SkillEntry {
    const entry = this.db.prepare("SELECT * FROM skill_library WHERE id=?").get(id) as
      | SkillEntry
      | undefined;
    if (!entry) throw new Error("skill_not_found");
    return entry;
  }
  revision(id: string, revision: number): SkillRevision {
    const row = this.db
      .prepare("SELECT bundle,created_at FROM skill_revisions WHERE skill_id=? AND revision=?")
      .get(id, revision) as { bundle: string; created_at: string } | undefined;
    if (!row) throw new Error("skill_revision_not_found");
    const bundle = parseSkill((JSON.parse(row.bundle) as SkillBundle).files);
    return { skillId: id, revision, bundle, createdAt: row.created_at };
  }
  history(id: string): SkillRevision[] {
    return (
      this.db
        .prepare("SELECT revision FROM skill_revisions WHERE skill_id=? ORDER BY revision DESC")
        .all(id) as { revision: number }[]
    ).map((row) => this.revision(id, row.revision));
  }
  add(candidate: SkillBundle, source?: string): SkillEntry {
    const bundle = parseSkill(candidate.files),
      id = randomUUID();
    return this.db.transaction(() => {
      if (
        this.db.prepare("SELECT id FROM skill_library WHERE name=? AND removed=0").get(bundle.name)
      )
        throw new Error("skill_name_conflict: choose a distinct name");
      this.db
        .prepare(
          "INSERT INTO skill_library(id,name,current_revision,source,source_hash) VALUES(?,?,1,?,?)",
        )
        .run(id, bundle.name, source ?? null, source ? bundle.hash : null);
      this.insert(id, 1, bundle);
      return this.get(id);
    })();
  }
  save(id: string, expected: number, candidate: SkillBundle): SkillRevision {
    const bundle = parseSkill(candidate.files);
    return this.db.transaction(() => {
      const old = this.get(id);
      if (old.removed) throw new Error("skill_removed");
      if (old.current_revision !== expected)
        throw new Error("skill_revision_conflict: draft retained; compare with current version");
      if (
        this.db
          .prepare("SELECT id FROM skill_library WHERE name=? AND id<>? AND removed=0")
          .get(bundle.name, id)
      )
        throw new Error("skill_name_conflict");
      this.db
        .prepare("UPDATE skill_library SET name=?,current_revision=? WHERE id=?")
        .run(bundle.name, expected + 1, id);
      this.insert(id, expected + 1, bundle);
      return this.revision(id, expected + 1);
    })();
  }
  updateSource(
    id: string,
    expected: number,
    source: SkillBundle,
    choice: "keep" | "replace" | "copy",
  ): SkillEntry {
    return this.db.transaction(() => {
      const entry = this.get(id);
      if (entry.current_revision !== expected) throw new Error("skill_revision_conflict");
      if (choice === "keep") return entry;
      if (choice === "copy") return this.add(source, entry.source ?? undefined);
      const saved = this.save(id, expected, source);
      this.db
        .prepare("UPDATE skill_library SET source_hash=? WHERE id=?")
        .run(saved.bundle.hash, id);
      return this.get(id);
    })();
  }
  remove(id: string, confirmed: boolean) {
    if (!confirmed) throw new Error("skill_remove_confirmation_required");
    this.db.transaction(() => {
      this.get(id);
      this.db.prepare("UPDATE skill_library SET removed=1 WHERE id=?").run(id);
      this.db.prepare("DELETE FROM skill_assignments WHERE skill_id=?").run(id);
      this.db
        .prepare("INSERT INTO skill_access_audit VALUES(?,?,?,?,?,?)")
        .run(
          randomUUID(),
          "local-owner",
          "library",
          id,
          "remove_confirmed",
          new Date().toISOString(),
        );
      // Revisions and snapshots deliberately retained for resumable native sessions.
    })();
  }
  assign(input: {
    profileId: string;
    scopeId: string;
    skillId: string;
    revision: number;
    enabled: boolean;
    confirmed: boolean;
    reservedNames: readonly string[];
  }) {
    this.db.transaction(() => {
      const { profileId, scopeId, skillId, revision, enabled } = input;
      if (enabled) {
        if (!input.confirmed) throw new Error("skill_enable_confirmation_required");
        const entry = this.get(skillId);
        if (entry.removed) throw new Error("skill_removed");
        const selected = this.revision(skillId, revision);
        if (
          input.reservedNames.some(
            (name) => name.toLowerCase() === selected.bundle.name.toLowerCase(),
          )
        )
          throw new Error("skill_name_conflict: native command or skill owns this name");
        for (const skill of this.resolve(profileId, [scopeId]))
          if (skill.skillId !== skillId && skill.name === selected.bundle.name)
            throw new Error("skill_name_conflict");
        this.db
          .prepare(
            "INSERT INTO skill_assignments(profile_id,scope_id,skill_id,revision,enabled) VALUES(?,?,?,?,1) ON CONFLICT(profile_id,scope_id,skill_id) DO UPDATE SET revision=excluded.revision,enabled=1",
          )
          .run(profileId, scopeId, skillId, revision);
      } else
        this.db
          .prepare(
            "INSERT INTO skill_assignments(profile_id,scope_id,skill_id,revision,enabled) VALUES(?,?,?,?,0) ON CONFLICT(profile_id,scope_id,skill_id) DO UPDATE SET enabled=0",
          )
          .run(profileId, scopeId, skillId, revision);
      this.db
        .prepare("INSERT INTO skill_access_audit VALUES(?,?,?,?,?,?)")
        .run(
          randomUUID(),
          profileId,
          scopeId,
          skillId,
          enabled ? "enable_confirmed" : "disable",
          new Date().toISOString(),
        );
    })();
  }
  assignments(profileId: string, scopeId: string) {
    return this.db
      .prepare(
        "SELECT skill_id AS skillId, revision FROM skill_assignments WHERE profile_id=? AND scope_id=? AND enabled=1 ORDER BY skill_id",
      )
      .all(profileId, scopeId) as { skillId: string; revision: number }[];
  }
  resolve(profileId: string, authorizedLineage: readonly string[]): SkillSelection[] {
    const selected = new Map<string, SkillSelection>();
    for (const scope of authorizedLineage)
      for (const row of this.db
        .prepare(
          "SELECT skill_id AS skillId, revision, enabled FROM skill_assignments WHERE profile_id=? AND scope_id=? ORDER BY skill_id",
        )
        .all(profileId, scope) as { skillId: string; revision: number; enabled: number }[]) {
        if (!row.enabled) {
          selected.delete(row.skillId);
          continue;
        }
        if (this.get(row.skillId).removed) continue;
        const revision = this.revision(row.skillId, row.revision),
          bundle = revision.bundle;
        selected.set(row.skillId, {
          skillId: row.skillId,
          revision: row.revision,
          name: bundle.name,
          hash: bundle.hash,
        });
      }
    const skills = [...selected.values()].sort((a, b) => a.name.localeCompare(b.name));
    if (new Set(skills.map((s) => s.name)).size !== skills.length)
      throw new Error("skill_name_conflict");
    return skills;
  }
  snapshot(manifestId: string): SkillSnapshot | undefined {
    const row = this.db
      .prepare("SELECT snapshot FROM skill_session_snapshots WHERE manifest_id=?")
      .get(manifestId) as { snapshot: string } | undefined;
    return row ? (JSON.parse(row.snapshot) as SkillSnapshot) : undefined;
  }
  freeze(
    manifestId: string,
    profileId: string,
    scopeId: string,
    authorizedLineage: readonly string[],
  ): SkillSnapshot {
    return this.db.transaction(() => {
      const previous = this.snapshot(manifestId);
      if (previous) {
        if (previous.profileId !== profileId || previous.scopeId !== scopeId)
          throw new Error("skill_snapshot_identity_mismatch");
        return previous;
      }
      if (!authorizedLineage.includes(scopeId)) throw new Error("skill_scope_denied");
      const snapshot = {
        manifestId,
        profileId,
        scopeId,
        skills: this.resolve(profileId, authorizedLineage),
      };
      this.db
        .prepare("INSERT INTO skill_session_snapshots VALUES(?,?,?,?,?)")
        .run(manifestId, profileId, scopeId, JSON.stringify(snapshot), new Date().toISOString());
      return snapshot;
    })();
  }
  private insert(id: string, revision: number, bundle: SkillBundle) {
    this.db
      .prepare("INSERT INTO skill_revisions VALUES(?,?,?,?,?)")
      .run(id, revision, bundle.hash, JSON.stringify(bundle), new Date().toISOString());
  }
}
