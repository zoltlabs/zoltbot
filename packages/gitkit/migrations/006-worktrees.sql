-- Finalized separately from live sequence during concurrent implementation.
-- Intent rows supplement existing workspace projections; no user content is copied here.
CREATE TABLE managed_worktree_operations (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  repository TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('preparing','ready','missing','failed','archiving','archived')),
  body TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX managed_worktree_task ON managed_worktree_operations(task_id);
CREATE TABLE worktree_review_evidence (
  task_id TEXT NOT NULL,
  task_revision INTEGER NOT NULL,
  source_commit TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(task_id, task_revision, source_commit)
);
