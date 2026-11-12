# Store

The Mac opens a store with `openStore(file)` from `@zoltbot/store`. It keeps WAL,
foreign keys, filesystem backups before upgrades, and the native SQLite statement
and transaction behavior.

Cells import `@zoltbot/store/portable`, call `migrateDriver(driver)`, then construct
`new Store(driver)`. That entry has no filesystem or native SQLite imports. The
host supplies a synchronous `SqlDriver` and owns its backup and recovery policy.
`changes` means SQLite's `changes()`, excluding writes by triggers and indexes.

SQL migrations remain the source of truth. After editing them, run
`pnpm --filter @zoltbot/store migrations:generate` and commit the generated module.
The portability tests check the module and bundle the portable entry for a browser.

`read({projectId})` and `read({taskId})` load owned rows through indexed lookups,
including the selected threads' messages and deliveries. They add referenced project,
profile, agent definition and workspace records by primary key. They do not load
unrelated global configuration. Cell commands pass the same scope to `dispatch`.
The Mac's existing snapshots and item scopes keep their behavior.

A cell starts `rebuildStep(undefined, maxEvents)`, persists each returned cursor,
and stops when it receives `null`. `rebuildProgress()` recovers the committed cursor
after restart. Each call handles at most 5,000 events. Reads of projections and new
commands fail with `store_rebuilding` between steps. The event log remains readable.
The Mac retains its one-shot rebuild, which also accommodates daemon-owned auxiliary
foreign keys. The cell must not populate those daemon-owned tables.

A full disk rolls back a command and reports `storage_full`; existing reads remain
available. Each item version keeps its body in the event log. The item and JSON projections
reference that event, and FTS uses external content, so those tables do not store
additional copies of the body. Older event versions remain available for replay.

Resumable rebuilds hydrate one event at a time and stop after the requested count
or one MiB of encoded events, whichever comes first. A single larger event is
applied by itself. This bounds transcript memory without changing the Mac's
one-shot rebuild.
