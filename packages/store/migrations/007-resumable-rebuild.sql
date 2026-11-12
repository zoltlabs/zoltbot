-- Cell alarms resume from this committed cursor after an eviction or restart.
CREATE TABLE store_rebuild (
  id INTEGER PRIMARY KEY CHECK(id=1),
  cursor INTEGER NOT NULL,
  target INTEGER NOT NULL
);
