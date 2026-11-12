# Sandbox provider operations

`SandboxOrchestrator` runs provider effects behind an injected durable operation
journal. It does not authenticate accounts, reserve budget, decrypt credentials,
launch workers or implement account deletion. The Global service must provide
those policies and fence the current operation for each task before using it.

The journal inserts one record per org/member/task/operation ID and compares its
version in short transactions. The helper commits an attempt before provider I/O.
Environment values enter only the winning create callback and target; records
contain configuration IDs, fingerprints, scope and provider references. The
configuration ID identifies frozen startup material and must contain no secret.

Implementation choices:

- Discovery uses four hashed identity labels. Every supplied label must match;
  lookup never wakes a sandbox or reads its environment. Pagination is bounded.
- A create with an uncertain response reconciles through labels. An empty lookup
  remains pending and never causes a second create. It is not proof that a slow
  create cannot finish later. Operational resolution of a permanently uncertain
  create remains caller work; account deletion must retain its journal until it
  has reconciled ownership.
- A failed preparation can retry after fifteen seconds because no provider create
  has started. A lifecycle operation retries after thirty seconds if its target
  state has not been confirmed. A matching target state completes without another
  effect. The helper returns fixed states and does not retain provider errors.
- Multiple discovered resources are all recorded as ambiguous for cleanup. The
  helper does not choose one or drop the extra references.
- Operation results are immutable receipts. The caller must separately report
  the sandbox's current account-service state and reject stale operations after
  replacement, revocation or deletion. It must retain references while an effect
  is in flight and recheck authority before worker startup.

Headless tests use the fake target and an in-memory journal port. They inject
concurrent creation, lost provider replies, failures before/after journal writes,
ambiguous lookup and lifecycle retries. A provider/KMS callback runs outside the
journal's simulated transaction. These tests do not prove PostgreSQL persistence,
live provider semantics, quota enforcement or deletion retries. Those remain W9
and W12 gates.
