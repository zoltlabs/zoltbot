-- Independent initiative and organization records. Existing team aliases remain readable.
CREATE TABLE initiative_records (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE manager_remits (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE company_plans (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE project_briefs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX initiative_records_project ON initiative_records(project_id);
CREATE INDEX company_plans_project ON company_plans(project_id);
CREATE INDEX project_briefs_project ON project_briefs(project_id);
-- Retain the legacy hierarchy FK for old records; new work points at independent initiatives.
ALTER TABLE tasks ADD COLUMN initiative_record_id TEXT REFERENCES initiative_records(id);
