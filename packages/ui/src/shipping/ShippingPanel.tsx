import type { Shipping, ShippingFeedback } from "@zoltbot/protocol";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ChatConnection, Row } from "../chat/types.js";
import { Button } from "../components/primitives.js";
import { useShell } from "../state.js";
import { ExternalLink, ShippingDetails } from "./ShippingDetails.js";
import { LinkForm, Proposal, PublishForm } from "./ShippingForms.js";
import { shippingError } from "./view.js";
import "./shipping.css";

type View = {
  binding?: Shipping;
  local?: Row;
  feedback?: ShippingFeedback[];
  operations?: Row[];
  taskState?: string;
  revision?: number;
};
export function ShippingPanel({ id, connection }: { id: string; connection: ChatConnection }) {
  const titleId = useId(),
    noteId = useId(),
    heading = useRef<HTMLHeadingElement>(null),
    request = useRef(0);
  const close = useShell((s) => s.closeShipping),
    navigate = useShell((s) => s.navigate);
  const task = connection.snapshot.entities.task?.find((t) => t.id === id);
  const [view, setView] = useState<View>(() => {
      const cached = connection.snapshot.entities.shipping?.find((row) => row.taskId === id) as
        | Shipping
        | undefined;
      return {
        ...(cached ? { binding: cached } : {}),
        taskState: String(task?.state ?? ""),
        revision: Number(task?.revision ?? 1),
        local: { loading: true },
      };
    }),
    [setup, setSetup] = useState<Row>();
  const [form, setForm] = useState<"publish" | "link" | undefined>();
  const [proposal, setProposal] = useState<{ kind: string; value: Row; commandId: string }>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [selected, setSelected] = useState<string[]>([]),
    [note, setNote] = useState("");
  const [diagnostics, setDiagnostics] = useState<Record<string, string>>({});
  const [mergeMethod, setMergeMethod] = useState("SQUASH");
  const online = connection.status === "online",
    call = connection.call;
  const binding = view.binding,
    snapshot = binding?.snapshot;
  const load = useCallback(
    async (refresh = false) => {
      const generation = ++request.current;
      try {
        const next = (await call(refresh ? "shipping.refresh" : "shipping.get", { id })) as View;
        if (generation === request.current) {
          setView(next);
          if (refresh) setError("");
        }
      } catch (problem) {
        if (generation === request.current) setError(shippingError(problem));
      }
    },
    [call, id],
  );
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    heading.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !document.querySelector("dialog[open]")) close();
    };
    window.addEventListener("keydown", key);
    return () => {
      request.current++;
      window.removeEventListener("keydown", key);
      trigger?.focus();
    };
  }, [close]);
  useEffect(() => {
    if (online) void load();
  }, [load, online]);
  const snapshotHead = snapshot?.head;
  useEffect(() => {
    if (snapshotHead) setDiagnostics({});
  }, [snapshotHead]);
  useEffect(() => {
    if (!online || snapshot?.state !== "OPEN") return;
    let backoff = 30000,
      timer: ReturnType<typeof setTimeout>,
      stopped = false;
    const refresh = async () => {
      const generation = ++request.current;
      try {
        const next = (await call("shipping.refresh", { id })) as View;
        if (!stopped && generation === request.current) {
          setView(next);
          backoff = 30000;
        }
      } catch {
        backoff = Math.min(backoff * 2, 300000);
      }
      if (!stopped) timer = setTimeout(refresh, backoff);
    };
    timer = setTimeout(refresh, backoff);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [call, id, online, snapshot?.state]);
  async function act(method: string, values: Row, commandId: string = crypto.randomUUID()) {
    if (!online || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = (await call(method, { id, ...values }, commandId)) as Row;
      if (method.endsWith("Preview")) {
        setProposal({ kind: method.slice(9, -7), value: result, commandId: crypto.randomUUID() });
        setForm(undefined);
      } else if (result.pendingApproval)
        setNotice(
          "Approve publication in Needs you, then use the same confirmation button here to continue.",
        );
      else {
        setProposal(undefined);
        setForm(undefined);
        setNotice(
          method === "shipping.feedback"
            ? result.state === "held"
              ? "Feedback held. Review the changed source before resending."
              : result.state === "queued"
                ? "Feedback queued for the next task boundary."
                : "Feedback delivered as a new task revision."
            : "Action completed.",
        );
        if (method === "shipping.feedback") {
          setSelected([]);
          setNote("");
        }
        await load();
      }
    } catch (problem) {
      setError(shippingError(problem));
      await load();
    } finally {
      setBusy(false);
    }
  }
  async function beginPublish() {
    if (!online || busy) return;
    setBusy(true);
    setError("");
    try {
      const next = (await call("shipping.setup", { id })) as Row;
      setSetup(next);
      setForm("publish");
      setProposal(undefined);
    } catch (problem) {
      setError(shippingError(problem));
    } finally {
      setBusy(false);
    }
  }
  async function fetchDiagnostics(checkId: string) {
    try {
      const result = (await call("shipping.diagnostics", { id, checkId })) as { text: string };
      setDiagnostics((previous) => ({ ...previous, [checkId]: result.text }));
    } catch (problem) {
      setError(shippingError(problem));
    }
  }
  const local = view.local ?? {},
    batches = view.feedback ?? [];
  const defaults = {
    remote: binding?.remote,
    branch: binding?.branch,
    baseBranch: binding?.baseBranch,
    title: snapshot?.title ?? String(task?.title ?? ""),
    body: `## Goal\n${String(task?.brief ?? "").split("\n\nReview feedback:\n")[0]}\n\n## Acceptance criteria\n${String(task?.acceptance ?? "Not specified")}\n\n## Agent-reported result\n${String(connection.snapshot.entities.taskResult?.find((r) => r.taskId === id && r.revision === task?.revision)?.summary ?? "No current result recorded.")}\n\n## Validation\nReview the task's recorded evidence. Test results are not inferred from the agent summary.`,
    draft: snapshot?.draft ?? true,
    number: snapshot?.number,
  };
  return createPortal(
    <aside className="zb shipping-panel" aria-labelledby={titleId}>
      <header className="shipping-header">
        <h2 id={titleId} tabIndex={-1} ref={heading}>
          Shipping · <bdi>{String(task?.title ?? "Task")}</bdi>
        </h2>
        <Button onClick={close}>Close shipping</Button>
      </header>
      <div className="shipping-content">
        {!online ? (
          <output>
            Reconnect to the local daemon. Showing last known GitHub state. Publishing and feedback
            are unavailable.
          </output>
        ) : null}
        {error ? <p role="alert">{error}</p> : null}
        <output aria-live="polite">{busy ? "Working…" : notice}</output>
        {binding ? (
          <section>
            <p>
              <bdi>{binding.repository}</bdi> · Signed in as @{binding.account}
            </p>
            <p>
              <bdi>{binding.branch}</bdi> → <bdi>{binding.baseBranch}</bdi>
            </p>
            {snapshot ? (
              <>
                <p>
                  PR #{snapshot.number} · {snapshot.draft ? "Draft · " : ""}
                  {snapshot.state.toLowerCase()}
                </p>
                <ExternalLink url={snapshot.url}>Open on GitHub</ExternalLink>
                <p className="dim sm">
                  Last updated {new Date(snapshot.fetchedAt).toLocaleString()}. Refresh is
                  approximate.
                </p>
                <Button size="sm" disabled={!online || busy} onClick={() => void load(true)}>
                  Refresh GitHub
                </Button>
                {binding.error ? (
                  <output>The latest refresh failed. These are cached results.</output>
                ) : null}
                <p>
                  GitHub merge status: {snapshot.mergeState.toLowerCase().replaceAll("_", " ")} ·{" "}
                  {snapshot.mergeable.toLowerCase().replaceAll("_", " ")}
                </p>
              </>
            ) : null}
            {binding.readOnly ? (
              <p>
                This link is observation only. Reconcile the task and PR history before publishing
                changes.
              </p>
            ) : null}
          </section>
        ) : (
          <section>
            <p>
              Create a draft pull request from this task's reviewed commit, or link an existing PR.
            </p>
            <p className="dim sm">
              Requires GitHub CLI and your existing login. Run <code>gh auth login</code> on this
              Mac if needed. Git credentials are checked separately when publishing.
            </p>
          </section>
        )}
        {snapshot?.queuePosition ? (
          <output>
            In GitHub merge queue · position {snapshot.queuePosition}. GitHub controls when this PR
            is merged.
          </output>
        ) : null}
        <section>
          <h3>Local work</h3>
          <p>
            Task result: {String(view.taskState ?? task?.state ?? "Unknown")} · Revision{" "}
            {String(view.revision ?? task?.revision ?? "")}
          </p>
          <p>
            Reviewed commit:{" "}
            <code>
              {String(
                local.loading
                  ? "Checking local Git state…"
                  : local.reviewedHead || "Not recorded for this revision",
              )}
            </code>
          </p>
          {snapshot ? (
            <p>
              GitHub head: <code>{snapshot.head}</code>
            </p>
          ) : null}
          {snapshot && local.reviewedHead && local.reviewedHead !== snapshot.head ? (
            <p>Reviewed commit not pushed. GitHub checks describe the previous push.</p>
          ) : null}
          {local.dirty ? (
            <p>There are uncommitted changes; they are not included in publication.</p>
          ) : null}
          {local.unavailable ? (
            <p>
              The task worktree is unavailable. Restore or recover it from task Changes before
              continuing.
            </p>
          ) : null}
          <p className="dim sm">
            Accept result, Integrate locally, Push, and Merge on GitHub are separate actions.
          </p>
          {!binding?.readOnly && (!snapshot || snapshot.state === "OPEN") ? (
            <Button
              disabled={
                !online ||
                busy ||
                Boolean(local.unavailable) ||
                !local.reviewedHead ||
                !["review", "completed"].includes(String(view.taskState))
              }
              onClick={() => void beginPublish()}
            >
              {snapshot ? "Push reviewed update…" : "Create pull request…"}
            </Button>
          ) : null}
          {!binding ? (
            <Button
              disabled={!online || busy}
              onClick={() => {
                setForm("link");
                setProposal(undefined);
              }}
            >
              Link existing PR…
            </Button>
          ) : null}
          <Button
            onClick={() => {
              close();
              navigate("Inbox");
            }}
          >
            Open Needs you for Git approvals
          </Button>
        </section>
        {form === "publish" && setup ? (
          <PublishForm
            key={String(setup.account)}
            setup={setup}
            defaults={defaults}
            busy={busy}
            call={act}
            cancel={() => setForm(undefined)}
          />
        ) : null}
        {form === "link" ? (
          <LinkForm busy={busy} call={act} cancel={() => setForm(undefined)} />
        ) : null}
        {proposal ? (
          <Proposal
            kind={proposal.kind}
            proposal={proposal.value}
            busy={busy || !online}
            cancel={() => setProposal(undefined)}
            confirm={() =>
              void act(
                `shipping.${proposal.kind}`,
                { fingerprint: proposal.value.fingerprint, confirmed: true },
                proposal.commandId,
              )
            }
          />
        ) : null}
        {snapshot ? (
          <>
            <ShippingDetails
              snapshot={snapshot}
              selected={selected}
              setSelected={setSelected}
              diagnostics={diagnostics}
              fetchDiagnostics={fetchDiagnostics}
              batches={batches}
            />
            <section>
              <h3>Send feedback to agent</h3>
              <label htmlFor={noteId}>Your instruction (optional)</label>
              <textarea
                id={noteId}
                value={note}
                rows={3}
                maxLength={2000}
                onChange={(e) => setNote(e.target.value)}
              />
              <p>
                {selected.length} items selected. Selection can include outdated or resolved
                comments; inspect those before sending.
              </p>
              <Button
                disabled={
                  !online ||
                  busy ||
                  !selected.length ||
                  snapshot.state !== "OPEN" ||
                  Boolean(local.unavailable)
                }
                onClick={() => void act("shipping.feedbackPreview", { selected, note })}
              >
                Review selected feedback…
              </Button>
              {batches
                .filter((b) => ["queued", "held"].includes(b.state))
                .map((batch) => (
                  <div key={batch.id}>
                    <p>
                      Feedback {batch.state}
                      {batch.reason ? `: ${batch.reason.replaceAll("_", " ")}` : ""}.
                    </p>
                    <Button
                      disabled={!online || busy}
                      onClick={() =>
                        void act("shipping.cancelFeedback", { batchId: batch.id, confirmed: true })
                      }
                    >
                      Cancel feedback batch
                    </Button>
                  </div>
                ))}
            </section>
            {snapshot.state === "OPEN" ? (
              <section>
                <h3>Merge on GitHub</h3>
                <p>
                  Requires an accepted task, a current reviewed and pushed head, and GitHub
                  reporting a clean merge state. Drafts must be marked ready on GitHub.
                </p>
                <label htmlFor={`${noteId}-merge`}>Merge method</label>{" "}
                <select
                  id={`${noteId}-merge`}
                  value={
                    snapshot.mergeMethods.includes(mergeMethod as "SQUASH")
                      ? mergeMethod
                      : snapshot.mergeMethods[0]
                  }
                  onChange={(e) => setMergeMethod(e.target.value)}
                >
                  {snapshot.mergeMethods.map((m) => (
                    <option key={m} value={m}>
                      {m.toLowerCase()}
                    </option>
                  ))}
                </select>
                <Button
                  disabled={
                    !online ||
                    busy ||
                    binding?.readOnly ||
                    snapshot.queuePosition !== undefined ||
                    snapshot.draft ||
                    !snapshot.canMerge ||
                    view.taskState !== "completed" ||
                    snapshot.mergeState !== "CLEAN"
                  }
                  onClick={() =>
                    void act("shipping.mergePreview", {
                      method: snapshot.mergeMethods.includes(mergeMethod as "SQUASH")
                        ? mergeMethod
                        : snapshot.mergeMethods[0],
                    })
                  }
                >
                  Review merge…
                </Button>
              </section>
            ) : snapshot.state === "MERGED" ? (
              <output>
                Merged on GitHub. Your local destination branch is unchanged. Use the existing task
                controls to archive the worktree when ready.
              </output>
            ) : (
              <p>This PR is closed. Local work is preserved.</p>
            )}
          </>
        ) : null}
        {(view.operations ?? [])
          .filter((o) => o.state !== "done")
          .map((operation) => (
            <section key={String(operation.id)}>
              <h3>Unfinished {String(operation.kind)}</h3>
              <p>
                Stage: {String(operation.state)}. Retry reconciles the remote result before
                continuing.
              </p>
              <Button
                disabled={!online || busy}
                onClick={() =>
                  void act(
                    `shipping.${String(operation.kind)}`,
                    { fingerprint: operation.fingerprint, confirmed: true },
                    String(operation.id),
                  )
                }
              >
                Reconcile operation
              </Button>
            </section>
          ))}
      </div>
    </aside>,
    document.body,
  );
}
