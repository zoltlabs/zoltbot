-- Canonical initial SQLite schema. Pre-launch databases must be recreated.
-- Future schema changes append migrations after this baseline.

CREATE TABLE events (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id       TEXT NOT NULL UNIQUE,
  command_id     TEXT,
  aggregate_type TEXT NOT NULL,
  aggregate_id   TEXT NOT NULL,
  type           TEXT NOT NULL,
  occurred_at    TEXT NOT NULL,
  payload        TEXT NOT NULL
);

CREATE INDEX events_aggregate ON events(aggregate_type, aggregate_id, seq);

CREATE TABLE command_receipts (
  command_id TEXT PRIMARY KEY,
  result     TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE agent_definitions (
  id          TEXT PRIMARY KEY,         -- 'claude', 'codex', 'acp:gemini', ...
  source      TEXT NOT NULL,            -- 'builtin' | 'user' | 'registry'
  body        TEXT NOT NULL,            -- JSON, see 07
  updated_at  TEXT NOT NULL
);

CREATE TABLE agents (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  definition_id   TEXT NOT NULL REFERENCES agent_definitions(id),
  role_text       TEXT NOT NULL DEFAULT '',
  model           TEXT,
  effort          TEXT,
  permission_profile TEXT NOT NULL DEFAULT 'workspace_write',
  instructions    TEXT NOT NULL DEFAULT '',
  hidden          INTEGER NOT NULL DEFAULT 0,
  archived        INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
, kind TEXT NOT NULL DEFAULT 'profile', avatar TEXT NOT NULL DEFAULT '');

CREATE TABLE projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, goal TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '', constraints TEXT NOT NULL DEFAULT '',
  roots TEXT NOT NULL DEFAULT '[]',                 -- JSON list of { path, repo_root, label }
  hierarchy_mode TEXT NOT NULL DEFAULT 'flat',      -- 'flat' | 'areas' | 'full'
  tags TEXT NOT NULL DEFAULT '[]',                  -- filtering only
  default_budget_usd REAL, setup_script TEXT, routing_rules TEXT NOT NULL DEFAULT '[]',
  archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
, preview_command TEXT, preview_url TEXT, require_code_review INTEGER NOT NULL DEFAULT 0, skip_final_gate_when_reviewed INTEGER NOT NULL DEFAULT 0, hierarchy_depth INTEGER NOT NULL DEFAULT 0);

CREATE TABLE areas (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL, goal TEXT NOT NULL DEFAULT '', instructions TEXT NOT NULL DEFAULT '',
  archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);

CREATE TABLE initiatives (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  area_id TEXT REFERENCES areas(id), name TEXT NOT NULL, goal TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '', root_label TEXT, budget_usd REAL,
  state TEXT NOT NULL DEFAULT 'active', archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);

CREATE TABLE node_assignments (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id),
  node_type TEXT NOT NULL,                          -- 'project' | 'area' | 'initiative'
  node_id TEXT NOT NULL,
  role TEXT NOT NULL,                               -- 'chief_of_staff' only (file 13)
  created_at TEXT NOT NULL, ended_at TEXT
);

CREATE TABLE threads (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id),
  project_id TEXT REFERENCES projects(id), task_id TEXT,
  kind TEXT NOT NULL,                      -- 'main' | 'task' | 'side'
  title TEXT NOT NULL DEFAULT '', title_source TEXT NOT NULL DEFAULT 'auto',
  pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
  last_activity_at TEXT NOT NULL, created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id),
  provider TEXT NOT NULL,                  -- definition id
  native_id TEXT,                          -- provider session or thread id
  cwd TEXT NOT NULL, workspace_id TEXT,
  state TEXT NOT NULL,                     -- 'starting' | 'ready' | 'running' | 'closed' | 'failed'
  model TEXT, effort TEXT, capabilities TEXT NOT NULL,   -- JSON snapshot
  provider_version TEXT, started_at TEXT NOT NULL, ended_at TEXT
);

CREATE TABLE turns (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id),
  session_id TEXT NOT NULL REFERENCES sessions(id),
  status TEXT NOT NULL,                    -- 'running' | 'completed' | 'failed' | 'interrupted'
  origin TEXT NOT NULL,                    -- 'human' | 'agent' | 'system'
  started_at TEXT NOT NULL, ended_at TEXT, stop_reason TEXT, error TEXT
);

CREATE TABLE items (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id),
  turn_id TEXT REFERENCES turns(id), seq INTEGER NOT NULL,
  kind TEXT NOT NULL,                      -- 'user' | 'message' | 'thought' | 'tool' | 'plan' | 'interaction' | 'note'
  phase TEXT,                              -- 'commentary' | 'final'
  body TEXT NOT NULL,                      -- JSON
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(thread_id, seq)
);

CREATE TABLE interactions (
  id TEXT PRIMARY KEY, version INTEGER NOT NULL,
  agent_id TEXT NOT NULL, thread_id TEXT NOT NULL, turn_id TEXT, task_id TEXT,
  type TEXT NOT NULL, urgency TEXT NOT NULL,
  state TEXT NOT NULL,                     -- 'pending' | 'answered' | 'cancelled' | 'expired'
  body TEXT NOT NULL,                      -- JSON (title, context, items, chain, timeout)
  resolution TEXT,                         -- JSON (who, when, device, automatic, answers)
  native_ref TEXT,                         -- provider request id
  created_at TEXT NOT NULL, resolved_at TEXT
);

CREATE INDEX interactions_pending ON interactions(state, urgency, created_at);

CREATE TABLE approval_rules (
  id TEXT PRIMARY KEY, scope TEXT NOT NULL, scope_id TEXT,   -- 'global' | 'project' | 'agent'
  tool TEXT NOT NULL, matcher TEXT NOT NULL,                 -- JSON
  decision TEXT NOT NULL, created_by TEXT NOT NULL,
  created_at TEXT NOT NULL, expires_at TEXT, revoked_at TEXT
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY, thread_id TEXT, task_id TEXT,
  from_ref TEXT NOT NULL, kind TEXT NOT NULL, reply_to TEXT,
  expects_reply INTEGER NOT NULL, priority TEXT NOT NULL, delivery TEXT NOT NULL,
  root_id TEXT NOT NULL, hops INTEGER NOT NULL, ttl_hops INTEGER NOT NULL,
  origin TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL,
  idempotency_key TEXT UNIQUE
);

CREATE TABLE deliveries (
  id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(id),
  to_agent_id TEXT NOT NULL, queue_order INTEGER NOT NULL,
  state TEXT NOT NULL,   -- 'queued' | 'held' | 'delivering' | 'delivered' | 'failed' | 'cancelled'
  turn_id TEXT, delivered_at TEXT, error TEXT
, hold_reason TEXT);

CREATE INDEX deliveries_queue ON deliveries(to_agent_id, state, queue_order);

CREATE TABLE grants (
  id TEXT PRIMARY KEY, holder_agent_id TEXT NOT NULL,
  capability TEXT NOT NULL,   -- 'message' | 'assign' | 'read_summary' | 'read_full' | 'control' | 'spawn'
  target TEXT NOT NULL,       -- agent id, group id, or '*'
  granted_by TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id),
  area_id TEXT REFERENCES areas(id), initiative_id TEXT REFERENCES initiatives(id),
  workflow_run_id TEXT, execution_location TEXT NOT NULL DEFAULT 'local_host',
  attempt INTEGER NOT NULL DEFAULT 1, max_attempts INTEGER NOT NULL DEFAULT 1,
  parent_id TEXT REFERENCES tasks(id), root_id TEXT NOT NULL,
  title TEXT NOT NULL, brief TEXT NOT NULL, acceptance TEXT NOT NULL DEFAULT '',
  expected_deliverable TEXT NOT NULL DEFAULT '',
  owner_agent_id TEXT, thread_id TEXT, workspace_mode TEXT NOT NULL,  -- 'shared' | 'worktree'
  workspace_id TEXT, base_ref TEXT, budget_usd REAL, budget_tokens INTEGER,
  state TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
  review_required INTEGER NOT NULL DEFAULT 1, review_state TEXT,
  hold_reason TEXT, created_by TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
, stage_id TEXT);

CREATE TABLE task_deps (task_id TEXT NOT NULL, depends_on TEXT NOT NULL, PRIMARY KEY(task_id, depends_on));

CREATE TABLE task_results (
  task_id TEXT NOT NULL, revision INTEGER NOT NULL, status TEXT NOT NULL,
  summary TEXT NOT NULL, files TEXT NOT NULL, digest TEXT NOT NULL,
  auto INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, deliverables TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY(task_id, revision)
);

CREATE TABLE "legacy_deliverables" (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, initiative_id TEXT, project_id TEXT,
  kind TEXT NOT NULL,                               -- 'report' | 'document' | 'spreadsheet' | 'site' | 'code_change' | 'other'
  title TEXT NOT NULL, version INTEGER NOT NULL, supersedes TEXT,
  ref TEXT NOT NULL,                                -- path, branch, or url
  evidence TEXT NOT NULL DEFAULT '[]',              -- JSON list of { kind, label, ref, status }
  validation_state TEXT NOT NULL DEFAULT 'none',    -- 'none' | 'passed' | 'failed' | 'partial'
  review_state TEXT NOT NULL, created_at TEXT NOT NULL
);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY, project_id TEXT, kind TEXT NOT NULL,  -- 'folder' | 'worktree'
  path TEXT NOT NULL, repo_root TEXT, branch TEXT, base_ref TEXT,
  state TEXT NOT NULL,       -- 'active' | 'orphaned' | 'removed'
  created_at TEXT NOT NULL
);

CREATE TABLE native_sessions (
  provider TEXT NOT NULL, native_id TEXT NOT NULL, cwd TEXT, title TEXT,
  last_activity_at TEXT, source TEXT, thread_id TEXT, adopted INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT NOT NULL, missing INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(provider, native_id)
);

CREATE TABLE usage_records_aux (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_id TEXT, task_id TEXT, project_id TEXT,
  input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
  cost_usd REAL, cost_known INTEGER NOT NULL DEFAULT 0,
  injected_tokens INTEGER NOT NULL DEFAULT 0, recorded_at TEXT NOT NULL
);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT,
  chain TEXT, result TEXT NOT NULL, detail TEXT, at TEXT NOT NULL
);

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);

CREATE TABLE knowledge_items (
  id TEXT PRIMARY KEY, scope_type TEXT NOT NULL, scope_id TEXT NOT NULL,
  kind TEXT NOT NULL, key TEXT, title TEXT NOT NULL, body TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]', owner TEXT NOT NULL, status TEXT NOT NULL,
  sources TEXT NOT NULL DEFAULT '[]', revision INTEGER NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0, review_by TEXT, supersedes TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_verified_at TEXT
, verification TEXT NOT NULL DEFAULT 'human', writer TEXT);

CREATE INDEX knowledge_scope ON knowledge_items(scope_type, scope_id, status);

CREATE TABLE knowledge_revisions (
  item_id TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL, title TEXT NOT NULL,
  changed_by TEXT NOT NULL, reason TEXT, at TEXT NOT NULL, PRIMARY KEY(item_id, revision)
);

CREATE TABLE knowledge_reads_aux (
  id TEXT PRIMARY KEY, task_id TEXT, session_id TEXT, query TEXT, item_ids TEXT NOT NULL, at TEXT NOT NULL
, token_estimate INTEGER NOT NULL DEFAULT 0);

CREATE TABLE workflows (
  id TEXT PRIMARY KEY, scope_type TEXT NOT NULL, scope_id TEXT NOT NULL, name TEXT NOT NULL,
  current_version INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, paused_reason TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE workflow_versions (
  workflow_id TEXT NOT NULL, version INTEGER NOT NULL, body TEXT NOT NULL,   -- WorkflowVersion JSON
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(workflow_id, version)
);

CREATE TABLE workflow_runs (
  id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, version INTEGER NOT NULL, task_id TEXT,
  trigger TEXT NOT NULL, inputs TEXT NOT NULL, state TEXT NOT NULL,   -- 'scheduled' | 'skipped' | 'running' | 'review' | 'done' | 'failed'
  result_hash TEXT, started_at TEXT, ended_at TEXT
);

CREATE TABLE check_results (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, revision INTEGER NOT NULL, name TEXT NOT NULL,
  status TEXT NOT NULL, output_ref TEXT, duration_ms INTEGER, at TEXT NOT NULL
);

CREATE TABLE external_actions_aux (
  key TEXT NOT NULL, task_id TEXT NOT NULL, kind TEXT NOT NULL, target TEXT,
  status TEXT NOT NULL,   -- 'started' | 'done' | 'failed' | 'marked_done' | 'marked_failed'
  note TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(task_id, key)
);

CREATE TABLE checkpoints (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, revision INTEGER NOT NULL, event_seq INTEGER NOT NULL,
  note TEXT NOT NULL, git_head TEXT, auto INTEGER NOT NULL DEFAULT 0, at TEXT NOT NULL
);

CREATE TABLE limits (
  scope_type TEXT NOT NULL, scope_id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(scope_type, scope_id)
);

CREATE TABLE model_catalog_aux (
  provider TEXT NOT NULL, model_id TEXT NOT NULL, info TEXT NOT NULL, seen_at TEXT NOT NULL,
  PRIMARY KEY(provider, model_id)
);

CREATE TABLE chats (            -- optional convenience view over threads
  thread_id TEXT PRIMARY KEY REFERENCES threads(id),
  node_type TEXT NOT NULL,       -- 'project' | 'area' | 'initiative'
  node_id TEXT NOT NULL,
  profile_id TEXT NOT NULL REFERENCES agents(id)
);

CREATE TABLE stage_runs (
  id TEXT PRIMARY KEY, workflow_run_id TEXT NOT NULL, stage_id TEXT NOT NULL,
  task_id TEXT, round INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL,           -- see section 5.5
  input_refs TEXT NOT NULL DEFAULT '[]',   -- deliverable ids with hashes
  deliverable_id TEXT, started_at TEXT, ended_at TEXT
);

CREATE TABLE subprojects (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
 parent_id TEXT REFERENCES subprojects(id), name TEXT NOT NULL, label TEXT NOT NULL,
 goal TEXT NOT NULL DEFAULT '', instructions TEXT NOT NULL DEFAULT '',
 depth INTEGER NOT NULL CHECK(depth BETWEEN 1 AND 3),
 archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);

CREATE TABLE projection_records (
 kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(kind,id)
);

CREATE VIRTUAL TABLE items_fts USING fts5(id UNINDEXED, thread_id UNINDEXED, text);

CREATE VIRTUAL TABLE knowledge_fts USING fts5(id UNINDEXED, text);

CREATE TABLE devices (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT NOT NULL, public_key TEXT NOT NULL,
 state TEXT NOT NULL, confirm_code TEXT, created_at TEXT NOT NULL, paired_at TEXT,
 last_seen_at TEXT, archived INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE knowledge_revision_snapshots (
 item_id TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL,
 PRIMARY KEY(item_id,revision)
);

CREATE TRIGGER knowledge_revision_insert AFTER INSERT ON projection_records
 WHEN NEW.kind='knowledge' BEGIN
 INSERT OR IGNORE INTO knowledge_revision_snapshots VALUES(NEW.id,json_extract(NEW.body,'$.revision'),NEW.body);
END;

CREATE TRIGGER knowledge_revision_update AFTER UPDATE ON projection_records
 WHEN NEW.kind='knowledge' BEGIN
 INSERT OR IGNORE INTO knowledge_revision_snapshots VALUES(NEW.id,json_extract(NEW.body,'$.revision'),NEW.body);
END;

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

CREATE TABLE routines (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, schedule TEXT NOT NULL, template TEXT NOT NULL,
  permission_ceiling TEXT NOT NULL, notify TEXT NOT NULL, paused INTEGER NOT NULL,
  next_run_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE INDEX routine_due ON routines(paused, next_run_at);

CREATE TABLE browser_evidence (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  metadata TEXT NOT NULL CHECK(json_valid(metadata))
);

CREATE INDEX browser_evidence_task ON browser_evidence(task_id);

CREATE TABLE browser_lifecycle (
  binding_id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL,
  nonce TEXT,
  state TEXT NOT NULL,
  mode TEXT NOT NULL,
  url TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE browser_observations (
  evidence_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY(evidence_id,session_id,item_id)
);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY, project_id TEXT, thread_id TEXT NOT NULL, key TEXT NOT NULL,
  title TEXT NOT NULL, kind TEXT NOT NULL, current_version_id TEXT NOT NULL,
  state TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE INDEX artifacts_project_key ON artifacts(project_id,key);

CREATE TABLE artifact_versions (
  id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL, number INTEGER NOT NULL,
  manifest_hash TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(artifact_id,number)
);

CREATE TABLE artifact_manifests_aux (
  version_id TEXT PRIMARY KEY, manifest TEXT NOT NULL CHECK(json_valid(manifest)),
  save_checks TEXT NOT NULL CHECK(json_valid(save_checks)), visible_text TEXT NOT NULL
);

CREATE TABLE artifact_comments (
  id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL, version_id TEXT NOT NULL,
  body TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE artifacts_fts USING fts5(id UNINDEXED,title,note,text);

CREATE TABLE artifact_blob_types_aux (
  hash TEXT NOT NULL, mime TEXT NOT NULL, bytes INTEGER NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(hash,mime)
);

CREATE TABLE artifact_saves_aux (
  command_id TEXT PRIMARY KEY, task_id TEXT, revision INTEGER,
  artifact_id TEXT NOT NULL, version_id TEXT NOT NULL, repository_root TEXT, created_at TEXT NOT NULL
);

CREATE INDEX artifact_saves_task ON artifact_saves_aux(task_id,revision);

CREATE TABLE artifact_repository_records_aux (
  project_id TEXT NOT NULL, root TEXT NOT NULL, path TEXT NOT NULL,
  artifact_id TEXT NOT NULL, version_id TEXT NOT NULL, source_hash TEXT NOT NULL,
  PRIMARY KEY(project_id,root,path)
);

CREATE TABLE artifact_repository_issues_aux (
  project_id TEXT NOT NULL, root TEXT NOT NULL, key TEXT NOT NULL, code TEXT NOT NULL,
  PRIMARY KEY(project_id,root,key)
);

CREATE TABLE artifact_repository_writes_aux (
  command_id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL, version_id TEXT NOT NULL,
  root TEXT NOT NULL, state TEXT NOT NULL, code TEXT, created_at TEXT NOT NULL
);

CREATE TABLE shipping (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE UNIQUE INDEX shipping_task ON shipping(task_id);

CREATE TABLE shipping_operations (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE INDEX shipping_operations_task ON shipping_operations(task_id);

CREATE TABLE shipping_feedback (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE INDEX shipping_feedback_task ON shipping_feedback(task_id);

CREATE INDEX knowledge_verification ON knowledge_items(verification, updated_at);

CREATE TABLE knowledge_proposals (
 id TEXT PRIMARY KEY, scope_type TEXT NOT NULL, scope_id TEXT NOT NULL, state TEXT NOT NULL,
 fingerprint TEXT NOT NULL, session_id TEXT NOT NULL, task_id TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE INDEX knowledge_proposal_fingerprint ON knowledge_proposals(fingerprint, state);

CREATE INDEX knowledge_proposal_state ON knowledge_proposals(state, scope_type, scope_id);

CREATE TABLE knowledge_session_taint (
 session_id TEXT PRIMARY KEY, cause TEXT NOT NULL, label TEXT, at TEXT NOT NULL
);

CREATE TRIGGER knowledge_session_taint_permanent BEFORE DELETE ON knowledge_session_taint
 BEGIN SELECT RAISE(ABORT,'taint_is_permanent'); END;

CREATE TABLE knowledge_writes_aux (
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL, task_id TEXT, thread_id TEXT,
 source TEXT NOT NULL, op TEXT NOT NULL, outcome TEXT NOT NULL, reason TEXT NOT NULL,
 item_id TEXT, revision INTEGER, proposal_id TEXT, scope_type TEXT, scope_id TEXT,
 kind TEXT, title TEXT, at TEXT NOT NULL
);

CREATE INDEX knowledge_writes_session ON knowledge_writes_aux(session_id, outcome);

CREATE INDEX knowledge_writes_task ON knowledge_writes_aux(task_id);

CREATE TABLE "context_packs" (
 id TEXT PRIMARY KEY, task_id TEXT, thread_id TEXT, revision INTEGER NOT NULL,
 included TEXT NOT NULL, excluded TEXT NOT NULL, token_estimate INTEGER NOT NULL,
 created_at TEXT NOT NULL
);

CREATE INDEX context_pack_thread ON context_packs(thread_id);

CREATE TRIGGER context_pack_immutable BEFORE UPDATE ON context_packs
 BEGIN SELECT RAISE(ABORT,'immutable_context_pack'); END;

CREATE TABLE quick_chats (
 id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE INDEX quick_chats_recent ON quick_chats(updated_at DESC);

CREATE TABLE quick_messages (
 id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES quick_chats(id) ON DELETE CASCADE,
 seq INTEGER NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL,
 created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX quick_messages_order ON quick_messages(chat_id, seq);

CREATE INDEX quick_messages_status ON quick_messages(status);

CREATE TABLE quick_requests (
 command_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES quick_chats(id) ON DELETE CASCADE,
 user_message_id TEXT NOT NULL, reply_id TEXT NOT NULL, created_at TEXT NOT NULL
);

CREATE TABLE quick_connections (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL, body TEXT NOT NULL, secret_ref TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE quick_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE compares (
 id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id), node TEXT,
 title TEXT NOT NULL DEFAULT '', ceiling TEXT NOT NULL CHECK(ceiling='read_only'),
 state TEXT NOT NULL CHECK(state IN ('open','resolved','closed')), resolution TEXT,
 input TEXT NOT NULL, output_mode TEXT, summary_thread_id TEXT REFERENCES threads(id),
 created_at TEXT NOT NULL, resolved_at TEXT
);

CREATE TABLE compare_members (
 thread_id TEXT PRIMARY KEY REFERENCES threads(id), compare_id TEXT NOT NULL REFERENCES compares(id),
 position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 3), vote TEXT CHECK(vote='better'),
 ceiling TEXT NOT NULL DEFAULT 'read_only' CHECK(ceiling IN ('read_only','profile')),
 UNIQUE(compare_id, position)
);

CREATE INDEX compare_members_by_compare ON compare_members(compare_id);

CREATE UNIQUE INDEX compare_one_vote ON compare_members(compare_id) WHERE vote='better';

CREATE TABLE orchestrations (
 id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id),
 project_id TEXT NOT NULL REFERENCES projects(id), brief TEXT NOT NULL,
 phases TEXT NOT NULL, state TEXT NOT NULL, revision INTEGER NOT NULL,
 workspace_id TEXT REFERENCES workspaces(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE INDEX orchestrations_by_thread ON orchestrations(thread_id);

CREATE INDEX items_controls ON items(thread_id) WHERE kind IN ('user','note');

CREATE TABLE "routine_occurrences" (
  id TEXT PRIMARY KEY, routine_id TEXT NOT NULL REFERENCES routines(id), scheduled_at TEXT NOT NULL,
  task_id TEXT REFERENCES tasks(id), status TEXT NOT NULL, outcome TEXT, notify TEXT NOT NULL,
  reason TEXT, permission_deadline TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  source_event TEXT, event_origin INTEGER NOT NULL DEFAULT 0, UNIQUE(task_id)
);

CREATE UNIQUE INDEX routine_schedule_slot ON routine_occurrences(routine_id, scheduled_at) WHERE event_origin=0;

CREATE TABLE schema_baseline (id TEXT PRIMARY KEY CHECK (id = 'canonical-v1'));
INSERT INTO schema_baseline(id) VALUES ('canonical-v1');
