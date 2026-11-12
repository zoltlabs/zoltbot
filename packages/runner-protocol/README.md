# Runner protocol

Runners and cells exchange JSON-RPC 2.0 messages with `runnerMethods` parameter
schemas. Runner events carry a task id, lease id and positive `runnerSeq`; acknowledgements
carry the last durable sequence. Command ids and lease ids let a runner reject stale
or repeated delivery. The receiver must authenticate each connection and enforce its
task and lease bindings before acting.

Launch manifests use the existing public connections, skills and knowledge shape.
Credentials are not manifest fields. Browser and artifact bindings remain opaque
objects owned by their runtime implementations.

Mac execution requests cap timeout at one hour and stdin at 64 KiB of text. Results
cap stdout and stderr schema lengths; execution code must enforce the stricter UTF-8
byte limits. A request is not permission to execute: the Mac must verify the signed
device approval before it runs anything.

`mac.exec.request.approval` carries the shared signed-approval envelope when the
Cell forwards an approved request to the Mac. An initial worker request can omit
it. The Mac must refuse execution without a verified, current device approval;
schema validation alone is insufficient. The envelope binds stdin by hash and
requires an absolute approved folder, timeout, task/turn, member, organization,
target and signing device, and issuance/expiry times.

Runner leases can include the bounded execution metadata needed to seed a remote
runner's separate cache. `queuedItems` holds at most eight input items per lease;
transcript history is excluded. The cell saves selected configuration per task
revision, while queued inputs and native continuation evidence reflect current
state. Relative launch paths resolve in the managed checkout.

Runner events carry normalized session/item/turn context. These fields remain
optional in the general wire schema for compatibility, but the hosted cell requires
`sessionId`. Mac hello messages default to declining new tasks; `acceptTasks: true`
opts in, and drain stops new assignments.

Commands may carry canonical input IDs, interaction versions and interrupt turn
IDs. Hosted runners use these fields to merge input without duplication, refuse
stale answers and avoid stopping a later turn. They remain optional in the general
wire schema for compatibility.

Native answer commands can include the provider request reference. Remote caches
use it to find the exact pending local interaction when its local ID differs from
the cell's ID; it is never authority to answer a different task or version.


Diff results bind task and revision and carry bounded relative paths, patch data
and capture metadata. Receivers validate the strict result schema and a one-MiB
aggregate UTF-8 limit before saving anything. A typed result is not authorization:
the Cell must also verify its current runner lease and task revision. The generated
schema includes command-result contracts separately from generic JSON-RPC results.
Push result types name the exact commit; publication handling is still unfinished.
