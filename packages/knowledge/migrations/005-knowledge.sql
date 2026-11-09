-- Immutable full revisions supplement the legacy title/body revision table.
CREATE TABLE knowledge_revision_snapshots (
 item_id TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL,
 PRIMARY KEY(item_id,revision)
);
INSERT INTO knowledge_revision_snapshots SELECT id,json_extract(body,'$.revision'),body
 FROM projection_records WHERE kind='knowledge';
CREATE TRIGGER knowledge_revision_insert AFTER INSERT ON projection_records
 WHEN NEW.kind='knowledge' BEGIN
 INSERT OR IGNORE INTO knowledge_revision_snapshots VALUES(NEW.id,json_extract(NEW.body,'$.revision'),NEW.body);
END;
CREATE TRIGGER knowledge_revision_update AFTER UPDATE ON projection_records
 WHEN NEW.kind='knowledge' BEGIN
 INSERT OR IGNORE INTO knowledge_revision_snapshots VALUES(NEW.id,json_extract(NEW.body,'$.revision'),NEW.body);
END;
CREATE TRIGGER context_pack_immutable BEFORE UPDATE ON context_packs
 BEGIN SELECT RAISE(ABORT,'immutable_context_pack'); END;

ALTER TABLE knowledge_reads_aux ADD COLUMN token_estimate INTEGER NOT NULL DEFAULT 0;
