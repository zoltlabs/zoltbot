import { useMemo, useState } from "react";
import { Dialog } from "../../components/primitives.js";
import { DiffCounts, FileDiffView } from "./DiffView.js";
import { countLines, diffLines, diffStats, type FileDiff } from "./diff-data.js";

/** Changes from one step or a whole turn, one file at a time, unified or side by side. */
export function DiffDialog({
  title,
  diffs,
  onClose,
}: {
  title: string;
  diffs: FileDiff[];
  onClose(): void;
}) {
  const [selected, setSelected] = useState(0),
    [split, setSplit] = useState(false);
  const files = useMemo(
    () => diffs.map((diff) => ({ diff, ...countLines(diffLines(diff)) })),
    [diffs],
  );
  const totals = useMemo(() => diffStats(diffs), [diffs]);
  const current = files[selected] ?? files[0];
  return (
    <Dialog
      open
      wide
      title={title}
      onClose={onClose}
      actions={
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
      }
    >
      <div className="chat-diff-toolbar">
        <span>
          {files.length} {files.length === 1 ? "change" : "changes"} <DiffCounts {...totals} />
        </span>
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
      </div>
      <div className={`chat-diff-body${files.length > 1 ? "" : " single"}`}>
        {files.length > 1 ? (
          <ul className="chat-diff-files" aria-label="Changed files">
            {files.map((file, index) => (
              // A file edited twice in one turn appears twice; its position tells them apart.
              // biome-ignore lint/suspicious/noArrayIndexKey: The list is fixed while the dialog is open.
              <li key={`${file.diff.path}:${index}`}>
                <button
                  type="button"
                  className="item"
                  aria-current={index === selected ? "true" : undefined}
                  onClick={() => setSelected(index)}
                >
                  <span className="truncate mono" title={file.diff.path}>
                    {file.diff.path || "File change"}
                  </span>
                  <DiffCounts added={file.added} removed={file.removed} />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {current ? (
          <div className="chat-diff-view">
            <FileDiffView key={`${selected}:${split}`} diff={current.diff} open split={split} />
          </div>
        ) : (
          <p className="tool-empty">No file changes.</p>
        )}
      </div>
    </Dialog>
  );
}
