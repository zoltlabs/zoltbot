CREATE TABLE view_grants (
 view_id TEXT NOT NULL REFERENCES view_records(id),
 permission TEXT NOT NULL CHECK(permission IN ('read','act','approve')),
 granted_at TEXT NOT NULL,
 PRIMARY KEY(view_id,permission)
);
-- Remember permissions already reviewed, including permissions the owner declined.
CREATE TABLE view_reviews (view_id TEXT PRIMARY KEY REFERENCES view_records(id), requested TEXT NOT NULL);
