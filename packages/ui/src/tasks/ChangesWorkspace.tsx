import { useMemo, useState } from "react";
import { DiffCounts, FileDiffView } from "../chat/tools/DiffView.js";
import { type Row, text } from "../chat/types.js";

/** Review scope is deliberately independent of provider turn/session state. */
export function ChangesWorkspace({ changes }: { changes: Row }) {
  const [split, setSplit] = useState(false);
  const [scope, setScope] = useState("base");
  const [selection, setSelection] = useState("");
  const [fileLimit, setFileLimit] = useState(200);
  const [filter, setFilter] = useState("");
  const [feedback, setFeedback] = useState("");
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  const files = ((scope === "base" ? changes.files : changes.uncommittedFiles) ?? []) as Row[];
  const visible = files.filter((file) =>
    text(file.path).toLowerCase().includes(filter.toLowerCase()),
  );
  const selected = visible.find((file) => file.path === selection) ?? visible[0];
  const totals = useMemo(
    () =>
      files.reduce<{ added: number; removed: number }>(
        (sum, file) => ({
          added: sum.added + Number(file.added || 0),
          removed: sum.removed + Number(file.removed || 0),
        }),
        { added: 0, removed: 0 },
      ),
    [files],
  );
  return (
    <section className="review-workspace" aria-label="Code review workspace">
      <div className="review-toolbar">
        <label>
          Compare{" "}
          <select
            value={scope}
            onChange={(event) => {
              setScope(event.target.value);
              setSelection("");
            }}
          >
            <option value="base">Task changes</option>
            <option value="head">Uncommitted changes</option>
          </select>
        </label>
        <label>
          Display{" "}
          <select
            value={split ? "split" : "unified"}
            onChange={(event) => setSplit(event.target.value === "split")}
          >
            <option value="unified">Unified</option>
            <option value="split">Side by side</option>
          </select>
        </label>
        <span>
          {files.length} {files.length === 1 ? "file" : "files"}
        </span>
        <DiffCounts {...totals} />
      </div>
      <p className="dim sm review-provenance">
        {scope === "base"
          ? "Original task base → working tree, including commits and local edits."
          : "HEAD → working tree, including staged and unstaged edits."}{" "}
        This comparison does not identify individual turn changes. Untracked content is not
        included.
      </p>
      <p className="sm review-revisions">
        Base <code>{text(scope === "base" ? changes.base : changes.head)}</code> · HEAD{" "}
        <code>{text(changes.head)}</code>
      </p>
      <div className="review-columns">
        <nav aria-label="Changed files">
          <label>
            Filter files{" "}
            <input value={filter} onChange={(event) => setFilter(event.target.value)} />
          </label>
          <ul>
            {visible.slice(0, fileLimit).map((file) => (
              <li key={text(file.path)}>
                <button
                  type="button"
                  aria-current={selected === file ? "true" : undefined}
                  onClick={() => setSelection(text(file.path))}
                >
                  <span className="mono">{text(file.path)}</span>
                  <DiffCounts added={Number(file.added)} removed={Number(file.removed)} />
                </button>
              </li>
            ))}
          </ul>
          {visible.length > fileLimit ? (
            <button type="button" onClick={() => setFileLimit(fileLimit + 200)}>
              Show next files
            </button>
          ) : null}
        </nav>
        <div className="review-file">
          {selected ? (
            <>
              <h5>{text(selected.path)}</h5>
              {selected.previousPath ? (
                <p>
                  Renamed from <code>{text(selected.previousPath)}</code>
                </p>
              ) : null}
              {selected.unavailable ? (
                <output>{text(selected.unavailable)}</output>
              ) : (
                <FileDiffView
                  split={split}
                  key={`${scope}:${text(selected.path)}:${text(selected.patch)}`}
                  diff={{ path: text(selected.path), patch: text(selected.patch) }}
                />
              )}
            </>
          ) : (
            <div className="review-empty">
              <p>{filter ? `No files match “${filter}”.` : "No changes in this comparison."}</p>
              {filter ? (
                <button type="button" className="btn sm" onClick={() => setFilter("")}>
                  Clear filter
                </button>
              ) : (
                <p className="dim sm">Edit files, then select Inspect changes to refresh.</p>
              )}
            </div>
          )}
        </div>
      </div>
      <details>
        <summary>Working tree status (includes untracked files)</summary>
        <pre>{text(changes.status) || "Clean working tree"}</pre>
      </details>
      <label>
        Review feedback for this task
        <textarea
          value={feedback}
          onChange={(event) => {
            setFeedback(event.target.value);
            setCopied(false);
            setCopyError("");
          }}
        />
      </label>
      <button
        type="button"
        className="btn sm"
        disabled={!feedback.trim()}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(
              `Review of ${scope === "base" ? "task base" : "HEAD"} ${text(scope === "base" ? changes.base : changes.head)} → working tree${selected ? `, file ${text(selected.path)}` : ""}:\n\n${feedback}`,
            );
            setCopied(true);
            setCopyError("");
          } catch {
            setCopyError(
              "Could not copy feedback. Select the text above and copy it manually, then paste it into the task conversation.",
            );
            setCopied(false);
          }
        }}
      >
        Copy feedback for conversation
      </button>
      <output>
        {copyError ||
          (copied
            ? "Copied. Open the task conversation and paste to send."
            : "Feedback stays here until you send it in the task conversation.")}
      </output>
    </section>
  );
}
