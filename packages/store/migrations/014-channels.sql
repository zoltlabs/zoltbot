-- Team channels: one per team with a manager and one per project with a CEO. Posts and
-- requests are their transcript; delivery itself stays on messages.
CREATE TABLE channels (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, team_id TEXT, lead_thread_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT);
CREATE TABLE channel_posts (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, project_id TEXT NOT NULL, request_id TEXT, created_at TEXT NOT NULL);
CREATE TABLE channel_requests (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, project_id TEXT NOT NULL, post_id TEXT NOT NULL, lead_thread_id TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX channels_project ON channels(project_id);
CREATE INDEX channel_posts_channel ON channel_posts(channel_id, created_at);
CREATE INDEX channel_requests_channel ON channel_requests(channel_id);
