CREATE TABLE wakes (
 id TEXT PRIMARY KEY,
 thread_id TEXT NOT NULL,
 status TEXT NOT NULL
);
CREATE INDEX wakes_thread ON wakes(thread_id);
CREATE INDEX wakes_status ON wakes(status);
ALTER TABLE threads ADD COLUMN wake_pending INTEGER;
ALTER TABLE threads ADD COLUMN wake_unread_at TEXT;
