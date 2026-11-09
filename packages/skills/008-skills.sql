CREATE TABLE skill_library (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, current_revision INTEGER NOT NULL,
  source TEXT, source_hash TEXT, removed INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX skill_library_active_name ON skill_library(name) WHERE removed=0;
CREATE TABLE skill_revisions (
  skill_id TEXT NOT NULL REFERENCES skill_library(id), revision INTEGER NOT NULL,
  hash TEXT NOT NULL, bundle TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(skill_id, revision)
);
CREATE TABLE skill_assignments (
  profile_id TEXT NOT NULL, scope_id TEXT NOT NULL, skill_id TEXT NOT NULL,
  revision INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)), PRIMARY KEY(profile_id, scope_id, skill_id),
  FOREIGN KEY(skill_id,revision) REFERENCES skill_revisions(skill_id,revision)
);
CREATE TABLE skill_session_snapshots (
  manifest_id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, scope_id TEXT NOT NULL,
  snapshot TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE skill_access_audit (
  id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, scope_id TEXT NOT NULL,
  skill_id TEXT NOT NULL, action TEXT NOT NULL, created_at TEXT NOT NULL
);

CREATE TRIGGER skill_revisions_no_update BEFORE UPDATE ON skill_revisions BEGIN
  SELECT RAISE(ABORT,'immutable_skill_revision');
END;
CREATE TRIGGER skill_revisions_no_delete BEFORE DELETE ON skill_revisions BEGIN
  SELECT RAISE(ABORT,'immutable_skill_revision');
END;
CREATE TRIGGER skill_snapshots_no_update BEFORE UPDATE ON skill_session_snapshots BEGIN
  SELECT RAISE(ABORT,'immutable_skill_snapshot');
END;
