# Daemon

Local tasks execute through `Runner` in `src/runner/interface.ts`.
`createInProcessRuntime` constructs the existing session manager and its in-process
runner together. Workspace preflight, native opens, input receipts, interactions,
interrupts, shutdown and diff collection retain their existing implementations.
`taskRunner` still accepts callback hosts for compatibility; the production daemon
supplies the runner.

Runner observations are opt-in. A Local task has no consumer and does not allocate
an event outbox or contact a cell. A cloud runner must use its own managed store and
runtime, separate from the Local runtime, and subscribe before starting its session.
Observations carry normalized session/thread/item/turn identities and display-safe
adapter events. Streaming text buffers incomplete private prefixes before emitting
deltas. Attached consumers apply backpressure; closing a consumer releases it.

Runtime option types and observation handling live in separate modules so the
existing session manager and worker remain below the module size limit.
