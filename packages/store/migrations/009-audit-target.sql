-- Scoped audit reads follow a project or task target without scanning other org records.
CREATE INDEX audit_target ON audit_log(target,id);
