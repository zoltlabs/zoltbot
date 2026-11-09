-- WP-59 (D-KNW-1): user scope, agent writes, proposals, taint and write audit.
-- Existing knowledge was written or accepted by a person: verification=human, writer=owner.
ALTER TABLE knowledge_items ADD COLUMN verification TEXT NOT NULL DEFAULT 'human';
ALTER TABLE knowledge_items ADD COLUMN writer TEXT;
UPDATE knowledge_items SET writer=owner WHERE writer IS NULL;
UPDATE projection_records
 SET body=json_set(body,'$.verification','human','$.writer',json(json_extract(body,'$.owner')))
 WHERE kind='knowledge' AND json_extract(body,'$.verification') IS NULL;
UPDATE knowledge_revision_snapshots
 SET body=json_set(body,'$.verification','human','$.writer',json(json_extract(body,'$.owner')))
 WHERE json_extract(body,'$.verification') IS NULL;
CREATE INDEX knowledge_verification ON knowledge_items(verification, updated_at);

-- The 002 proposal table was never written. Replace it with the projection shape.
DROP TABLE knowledge_proposals;
CREATE TABLE knowledge_proposals (
 id TEXT PRIMARY KEY, scope_type TEXT NOT NULL, scope_id TEXT NOT NULL, state TEXT NOT NULL,
 fingerprint TEXT NOT NULL, session_id TEXT NOT NULL, task_id TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
-- Rejection memory: an identical rejected write is refused without reaching the queue.
CREATE INDEX knowledge_proposal_fingerprint ON knowledge_proposals(fingerprint, state);
CREATE INDEX knowledge_proposal_state ON knowledge_proposals(state, scope_type, scope_id);

-- Taint is permanent for a native session: rows are inserted once and never deleted.
CREATE TABLE knowledge_session_taint (
 session_id TEXT PRIMARY KEY, cause TEXT NOT NULL, label TEXT, at TEXT NOT NULL
);
CREATE TRIGGER knowledge_session_taint_permanent BEFORE DELETE ON knowledge_session_taint
 BEGIN SELECT RAISE(ABORT,'taint_is_permanent'); END;

-- Agent write audit. Rejected writes keep no title or body.
CREATE TABLE knowledge_writes_aux (
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL, task_id TEXT, thread_id TEXT,
 source TEXT NOT NULL, op TEXT NOT NULL, outcome TEXT NOT NULL, reason TEXT NOT NULL,
 item_id TEXT, revision INTEGER, proposal_id TEXT, scope_type TEXT, scope_id TEXT,
 kind TEXT, title TEXT, at TEXT NOT NULL
);
CREATE INDEX knowledge_writes_session ON knowledge_writes_aux(session_id, outcome);
CREATE INDEX knowledge_writes_task ON knowledge_writes_aux(task_id);

-- Chats, the chief of staff and pipeline stages get packs too (KNW-19): task_id becomes optional.
DROP TRIGGER context_pack_immutable;
CREATE TABLE context_packs_014 (
 id TEXT PRIMARY KEY, task_id TEXT, thread_id TEXT, revision INTEGER NOT NULL,
 included TEXT NOT NULL, excluded TEXT NOT NULL, token_estimate INTEGER NOT NULL,
 created_at TEXT NOT NULL
);
INSERT INTO context_packs_014(id,task_id,revision,included,excluded,token_estimate,created_at)
 SELECT id,task_id,revision,included,excluded,token_estimate,created_at FROM context_packs;
DROP TABLE context_packs;
ALTER TABLE context_packs_014 RENAME TO context_packs;
CREATE INDEX context_pack_thread ON context_packs(thread_id);
CREATE TRIGGER context_pack_immutable BEFORE UPDATE ON context_packs
 BEGIN SELECT RAISE(ABORT,'immutable_context_pack'); END;
