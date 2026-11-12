-- The event log owns each version of an item's body. Projections reference that event.
ALTER TABLE projection_records RENAME TO projection_rows;
ALTER TABLE projection_rows ADD COLUMN body_event_id TEXT;
UPDATE projection_rows SET
 body_event_id=(SELECT event_id FROM events WHERE aggregate_type='item' AND aggregate_id=projection_rows.id ORDER BY seq DESC LIMIT 1),
 body=json_remove(body,'$.body')
 WHERE kind='item' AND EXISTS(SELECT 1 FROM events WHERE aggregate_type='item' AND aggregate_id=projection_rows.id);

CREATE VIEW projection_records AS
 SELECT p.kind,p.id,CASE WHEN p.body_event_id IS NULL THEN p.body
 ELSE json_set(p.body,'$.body',json(json_quote(json_extract(e.payload,'$.body')))) END AS body
 FROM projection_rows p LEFT JOIN events e ON e.event_id=p.body_event_id;
-- Auxiliary Mac features write non-item records directly. Preserve their SQL surface.
CREATE TRIGGER projection_records_insert INSTEAD OF INSERT ON projection_records BEGIN
 INSERT INTO projection_rows(kind,id,body) VALUES(NEW.kind,NEW.id,NEW.body)
 ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body,body_event_id=NULL;
END;
CREATE TRIGGER projection_records_update INSTEAD OF UPDATE ON projection_records BEGIN
 UPDATE projection_rows SET body=NEW.body,body_event_id=NULL WHERE kind=OLD.kind AND id=OLD.id;
END;
CREATE TRIGGER projection_records_delete INSTEAD OF DELETE ON projection_records BEGIN
 DELETE FROM projection_rows WHERE kind=OLD.kind AND id=OLD.id;
END;

ALTER TABLE items RENAME TO item_records;
ALTER TABLE item_records ADD COLUMN body_event_id TEXT;
UPDATE item_records SET
 body_event_id=(SELECT event_id FROM events WHERE aggregate_type='item' AND aggregate_id=item_records.id ORDER BY seq DESC LIMIT 1),
 body='{}'
 WHERE EXISTS(SELECT 1 FROM events WHERE aggregate_type='item' AND aggregate_id=item_records.id);
CREATE VIEW items AS
 SELECT i.rowid AS rowid,i.id,i.thread_id,i.turn_id,i.seq,i.kind,i.phase,
 CASE WHEN i.body_event_id IS NULL THEN i.body ELSE json_quote(json_extract(e.payload,'$.body')) END AS body,
 i.created_at,i.updated_at
 FROM item_records i LEFT JOIN events e ON e.event_id=i.body_event_id;
CREATE VIEW item_search_content AS SELECT rowid,id,thread_id,body AS text FROM items;
DROP TABLE items_fts;
CREATE VIRTUAL TABLE items_fts USING fts5(id UNINDEXED,thread_id UNINDEXED,text,content='item_search_content',content_rowid='rowid');
INSERT INTO items_fts(items_fts) VALUES('rebuild');
