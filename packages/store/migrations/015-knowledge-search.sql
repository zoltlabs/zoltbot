-- M1: knowledge search stems words ("invoice" finds "invoices") and ranks with BM25. Title,
-- body and tags are separate columns so a title match can weigh more than a body match.
DROP TABLE knowledge_fts;
CREATE VIRTUAL TABLE knowledge_fts USING fts5(
  id UNINDEXED, title, body, tags, tokenize = 'porter unicode61 remove_diacritics 2'
);
INSERT INTO knowledge_fts(id, title, body, tags)
SELECT id, title, body, COALESCE((SELECT group_concat(value, ' ') FROM json_each(knowledge_items.tags)), '')
FROM knowledge_items;
