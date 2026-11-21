-- Skills agents proposed to save or update. The owner saves or discards each one; the full
-- records, with the proposed SKILL.md, live in `projection_rows`.
CREATE TABLE skill_proposals (id TEXT PRIMARY KEY, state TEXT NOT NULL, name TEXT NOT NULL, agent_id TEXT NOT NULL, thread_id TEXT NOT NULL, session_id TEXT NOT NULL, skill_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX skill_proposals_state ON skill_proposals(state, agent_id);
