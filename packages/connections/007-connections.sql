CREATE TABLE connections_aux (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  body TEXT NOT NULL
);
CREATE INDEX connections_project_aux ON connections_aux(project_id);
CREATE TABLE connection_audit_aux (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id TEXT NOT NULL,
  action TEXT NOT NULL,
  version INTEGER NOT NULL,
  occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE launch_manifests_aux (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL UNIQUE,
  body TEXT NOT NULL,
  native_id TEXT,
  state TEXT NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','bound','terminal','aborted'))
);
