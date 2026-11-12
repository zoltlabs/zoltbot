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
