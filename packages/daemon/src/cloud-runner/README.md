# Cloud runner

This package is in progress. It contains the durable event journal for the Mac
runner and sandbox worker. Connection/reconnect handling, managed checkouts,
native command execution and Mac bridge integration are not complete. W5 is not
signed off, and this code does not connect a Local project to a cell.

## Event journal

`RunnerOutbox` owns one JSONL file per org/task, named with a hash of those IDs.
Its header binds the org, task, thread and lease. An observation from another
thread fails before writing. Its caller must supply the privacy guard and keep
one journal owner per task. The caller must keep account credentials and runner
bearer tokens out of journal inputs. New files use owner-only permissions and
refuse symlinks.

The journal appends and fsyncs an event before returning its runner sequence.
The runtime's optional `persistObservation` hook awaits that write before passing
the normalized, redacted event to other readers. It stays active without a stream
reader, so startup observations are not dropped. Local callers omit the hook and
retain the existing reader behavior and execution path.

Acknowledgements also fsync before releasing retained entries. A new connection
reconciles the cell's cursor before processing its lease, including when a recreated
cache has no old events. A regressed cell cursor fails explicitly; the journal
does not invent replacement history. Repeated or older ordinary acknowledgements
do not advance it backwards.

Startup scans bounded chunks and retains only file offsets for unacknowledged
events. It truncates a partial final line, but refuses a complete corrupted record
or a changed binding. Event records carry a content hash. Replay reads a bounded
batch; it does not hydrate the full transcript. Once a journal exceeds one MiB
and at least half its bytes are no longer needed, compaction writes a new file,
fsyncs it, renames it atomically and fsyncs the directory. Pending events and sequence
numbers survive compaction. Filesystem failures stop the journal with fixed error
codes rather than logging paths or content.

Tests cover reopening, acknowledgement replay, compaction, partial-tail recovery,
cell cursor seeding, scope refusal, known-private-value refusal and symlink safety.
The runtime test also checks durable observations without a reader and redaction
before persistence. The worker/daemon end-to-end replay gate still needs the
connection driver and W8 harness.
