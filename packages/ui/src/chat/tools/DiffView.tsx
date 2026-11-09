import { memo, useMemo, useState } from "react";
import { countLines, type DiffLine, diffLines, type FileDiff } from "./diff-data.js";
import "./tools.css";

const visibleLines = 400;
export function DiffCounts({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="tool-diff-counts">
      <span className="tool-diff-add">
        +{added}
        <span className="tool-sr"> lines added,</span>
      </span>
      <span className="tool-diff-del">
        −{removed}
        <span className="tool-sr"> lines removed</span>
      </span>
    </span>
  );
}
function Lines({ lines, split = false }: { lines: DiffLine[]; split?: boolean }) {
  const [page, setPage] = useState(0);
  const shown = lines.slice(page * visibleLines, (page + 1) * visibleLines);
  return (
    <>
      <pre
        className={`tool-diff-lines${split ? " review-split" : ""}`}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Bounded output scrolls and must support keyboard scrolling.
        tabIndex={0}
      >
        {shown.map((line, index) => (
          <span
            // Diff lines repeat freely; position is the only stable identity.
            // biome-ignore lint/suspicious/noArrayIndexKey: Lines are immutable for a given diff.
            key={index}
            className={`tool-diff-line ${line.kind}`}
          >
            <span className="tool-diff-gutter">
              {line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}
            </span>
            {split ? (
              <>
                <span className="review-old">
                  {line.kind !== "add" ? `${line.old ?? ""}  ${line.text}` : " "}
                </span>
                <span className="review-new">
                  {line.kind !== "del" ? `${line.new ?? ""}  ${line.text}` : " "}
                </span>
              </>
            ) : (
              <>
                {line.text || " "}
                {"\n"}
              </>
            )}
          </span>
        ))}
      </pre>
      {page > 0 ? (
        <button type="button" className="btn sm" onClick={() => setPage(page - 1)}>
          Previous lines
        </button>
      ) : null}
      {(page + 1) * visibleLines < lines.length ? (
        <button type="button" className="btn sm tool-more" onClick={() => setPage(page + 1)}>
          Next {Math.min(visibleLines, lines.length - (page + 1) * visibleLines)} lines
        </button>
      ) : null}
    </>
  );
}
/** One file's unified diff with line counts in its header; open unless the caller says otherwise. */
export const FileDiffView = memo(function FileDiffView({
  diff,
  open = true,
  split = false,
}: {
  diff: FileDiff;
  open?: boolean;
  split?: boolean;
}) {
  const lines = useMemo(() => diffLines(diff), [diff]);
  const counts = countLines(lines);
  return (
    <details className="tool-diff" open={open}>
      <summary>
        <span className="truncate mono" title={diff.path}>
          {diff.path || "File change"}
        </span>
        <DiffCounts {...counts} />
      </summary>
      {lines.length ? (
        <Lines key={diff.patch} lines={lines} split={split} />
      ) : (
        <p className="tool-empty">No line changes.</p>
      )}
    </details>
  );
});
/** A lone file's lines without a second header, for rows whose summary already names the file. */
const BareDiff = memo(function BareDiff({ diff }: { diff: FileDiff }) {
  const lines = useMemo(() => diffLines(diff), [diff]);
  return (
    <div className="tool-diff-bare">
      {lines.length ? <Lines lines={lines} /> : <p className="tool-empty">No line changes.</p>}
    </div>
  );
});
export function DiffList({
  diffs,
  open = true,
  bare = false,
}: {
  diffs: FileDiff[];
  open?: boolean;
  /** One file renders without its own header and border. */
  bare?: boolean;
}) {
  const seen = new Map<string, number>();
  if (bare && diffs.length === 1 && diffs[0]) return <BareDiff diff={diffs[0]} />;
  return (
    <div className="tool-diff-list">
      {diffs.map((diff) => {
        const count = seen.get(diff.path) ?? 0;
        seen.set(diff.path, count + 1);
        return <FileDiffView key={`${diff.path}:${count}`} diff={diff} open={open} />;
      })}
    </div>
  );
}
