import { useEffect, useId, useRef, useState } from "react";
import type { Row } from "../chat/types.js";
import { Button } from "../components/primitives.js";

type Call = (method: string, value: Row) => Promise<void>;
export function PublishForm({
  setup,
  defaults,
  busy,
  call,
  cancel,
}: {
  setup: Row;
  defaults: Row;
  busy: boolean;
  call: Call;
  cancel(): void;
}) {
  const id = useId(),
    remotes = (setup.remotes ?? []) as Row[];
  const [remote, setRemote] = useState(String(defaults.remote ?? remotes[0]?.name ?? ""));
  const current = remotes.find((r) => r.name === remote);
  const [branch, setBranch] = useState(String(defaults.branch ?? setup.suggestedBranch ?? ""));
  const [base, setBase] = useState(String(defaults.baseBranch ?? current?.defaultBranch ?? "main"));
  const [title, setTitle] = useState(String(defaults.title ?? "")),
    [body, setBody] = useState(String(defaults.body ?? "")),
    [draft, setDraft] = useState(defaults.draft !== false);
  return (
    <form
      className="shipping-form"
      onSubmit={(event) => {
        event.preventDefault();
        void call("shipping.publishPreview", {
          remote,
          branch,
          baseBranch: base,
          title,
          body,
          draft,
        });
      }}
    >
      <h3>{defaults.number ? "Push reviewed update" : "Create pull request"}</h3>
      <p>
        GitHub account: @{String(setup.account)}. Git push uses your configured Git credentials.
      </p>
      <label htmlFor={`${id}-remote`}>Repository</label>
      <select
        id={`${id}-remote`}
        value={remote}
        onChange={(e) => {
          setRemote(e.target.value);
          const next = remotes.find((r) => r.name === e.target.value);
          if (next) setBase(String(next.defaultBranch));
        }}
        disabled={Boolean(defaults.number) || busy}
      >
        {remotes.map((r) => (
          <option key={String(r.name)} value={String(r.name)}>
            {String(r.name)} · {String(r.repository)}
          </option>
        ))}
      </select>
      <label htmlFor={`${id}-base`}>Base branch</label>
      <input
        id={`${id}-base`}
        required
        maxLength={200}
        value={base}
        onChange={(e) => setBase(e.target.value)}
        disabled={Boolean(defaults.number) || busy}
      />
      <label htmlFor={`${id}-branch`}>Publishing branch</label>
      <input
        id={`${id}-branch`}
        required
        maxLength={200}
        value={branch}
        onChange={(e) => setBranch(e.target.value)}
        disabled={Boolean(defaults.number) || busy}
      />
      {defaults.number ? (
        <p>
          This action only pushes reviewed code. Edit the PR title, description, or draft status on
          GitHub.
        </p>
      ) : (
        <>
          <label htmlFor={`${id}-title`}>Title</label>
          <input
            id={`${id}-title`}
            required
            maxLength={256}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={busy}
          />
          <label htmlFor={`${id}-body`}>Description (plain Markdown)</label>
          <textarea
            id={`${id}-body`}
            rows={7}
            maxLength={16000}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            disabled={busy}
          />
          <details>
            <summary>Description preview</summary>
            <pre>{body}</pre>
          </details>
          <label>
            <input
              type="checkbox"
              checked={draft}
              onChange={(e) => setDraft(e.target.checked)}
              disabled={Boolean(defaults.number) || busy}
            />{" "}
            Create as draft
          </label>
        </>
      )}
      <p className="dim sm">
        The preview shows the entire reviewed commit range. Screenshots and other attachments are
        not uploaded.
      </p>
      <div className="r wrap">
        <Button type="submit" variant="primary" disabled={busy || !remote}>
          Review publication
        </Button>
        <Button disabled={busy} onClick={cancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
export function LinkForm({ busy, call, cancel }: { busy: boolean; call: Call; cancel(): void }) {
  const id = useId(),
    [url, setUrl] = useState("");
  return (
    <form
      className="shipping-form"
      onSubmit={(e) => {
        e.preventDefault();
        void call("shipping.linkPreview", { url });
      }}
    >
      <h3>Link existing pull request</h3>
      <label htmlFor={id}>GitHub pull request URL</label>
      <input
        id={id}
        type="url"
        required
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="https://github.com/owner/repo/pull/123"
      />
      <p>
        Linking reads the PR and never pushes code. A PR whose head does not match this task is
        linked for observation only.
      </p>
      <div className="r wrap">
        <Button type="submit" variant="primary" disabled={busy}>
          Review link
        </Button>
        <Button disabled={busy} onClick={cancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
export function Proposal({
  kind,
  proposal,
  busy,
  confirm,
  cancel,
}: {
  kind: string;
  proposal: Row;
  busy: boolean;
  confirm(): void;
  cancel(): void;
}) {
  const snapshot = proposal.snapshot as Row | undefined;
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  return (
    <section className="shipping-proposal" aria-label="Review shipping action">
      <h3 tabIndex={-1} ref={heading}>
        {kind === "publish"
          ? "Review publication"
          : kind === "feedback"
            ? "Review feedback to agent"
            : kind === "merge"
              ? "Review merge on GitHub"
              : "Review PR link"}
      </h3>
      {kind === "publish" ? (
        <>
          <p>
            Publish <code>{String(proposal.head)}</code> to <bdi>{String(proposal.repository)}</bdi>{" "}
            · <bdi>{String(proposal.branch)}</bdi> → <bdi>{String(proposal.baseBranch)}</bdi>
          </p>
          {!proposal.snapshotNumber ? (
            <>
              <p>{String(proposal.title)}</p>
              <pre>{String(proposal.body)}</pre>
            </>
          ) : (
            <p>
              Update the code in PR #{String(proposal.snapshotNumber)}. PR metadata is unchanged.
            </p>
          )}
          <p>
            Full proposed commit range from{" "}
            <code>{String(proposal.targetBase ?? proposal.base)}</code>:
          </p>
          <pre>{String(proposal.commits)}</pre>
          <pre>{String(proposal.files)}</pre>
          {proposal.dirty ? (
            <output>
              There are newer uncommitted changes. They are not included in this push.
            </output>
          ) : null}
          <p>
            Publishing sends this reviewed code to GitHub. Git hooks and credential helpers require
            approval in Needs you. Your local destination checkout is not updated.
          </p>
        </>
      ) : null}
      {kind === "link" ? (
        <>
          <p>
            PR #{String(snapshot?.number)} · {String(snapshot?.title)}
          </p>
          <p>
            {proposal.readOnly
              ? "Observation only: this PR head does not match the task's current reviewed commit."
              : "This PR matches the current reviewed commit."}
          </p>
        </>
      ) : null}
      {kind === "feedback" ? (
        <>
          <p>
            {String(proposal.taskState) === "completed"
              ? `Reopens the accepted task as revision ${Number(proposal.revision) + 1}.`
              : ["running", "blocked"].includes(String(proposal.taskState))
                ? "Queues feedback for the next task boundary without interrupting the agent."
                : `Starts revision ${Number(proposal.revision) + 1} in the same conversation.`}
          </p>
          <pre>{String(proposal.text)}</pre>
          <p>
            Conservative budget: {String(proposal.estimatedTokens)} / {String(proposal.limit)}{" "}
            tokens. Nothing is posted on GitHub.
          </p>
        </>
      ) : null}
      {kind === "merge" ? (
        <>
          <p>
            Merge PR #{String(proposal.number)} into {String(proposal.baseBranch)} on GitHub using{" "}
            {String(proposal.method).toLowerCase()}.
          </p>
          <p>
            Expected head: <code>{String(proposal.head)}</code>. GitHub will refuse if the head
            changes or repository rules prevent merging.
          </p>
          <p>Your local main branch and worktree will not be changed or deleted.</p>
        </>
      ) : null}
      <div className="r wrap">
        <Button variant="primary" disabled={busy} onClick={confirm}>
          {kind === "publish"
            ? proposal.snapshotNumber
              ? "Push reviewed commit"
              : proposal.draft
                ? "Push and create draft PR"
                : "Push and create PR"
            : kind === "feedback"
              ? "Send selected feedback"
              : kind === "merge"
                ? `Merge #${String(proposal.number)} on GitHub`
                : "Link pull request"}
        </Button>
        <Button disabled={busy} onClick={cancel}>
          Cancel
        </Button>
      </div>
    </section>
  );
}
