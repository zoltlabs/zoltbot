# Cell

`CellSqlDriver` adapts one Durable Object's SQLite storage to the portable store.
It uses `transactionSync` for transactions and reads `changes()` for direct row
counts. Mac connection pragmas are ignored because the platform owns them. Closing
the facade leaves platform storage intact. All connection state stays on the driver
instance.

The driver tests use an in-memory SQLite implementation of the platform surface.
They verify migrations, receipts, rollback, trigger row counts and instance isolation.
Worker-runtime tests for routing, hibernation and restart remain separate gates.
