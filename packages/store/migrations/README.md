# SQLite schema baseline

`001-initial.sql` creates the complete current schema on an empty database. It replaces
the pre-launch migration chain; it does not upgrade databases created by that chain.
The `schema_baseline` marker prevents old version numbers from being mistaken for
this baseline. Opening such a database fails with `prelaunch_database_reset_required`
without deleting or resetting its data. Stop the app and retain any developer data
or backups before explicitly recreating a disposable database. No reset runs automatically.

Future schema changes append numbered migrations after 001. Existing transactional
application, backups and rollback handling remain in the migration runner.
