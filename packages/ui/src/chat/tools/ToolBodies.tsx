import { useMemo, useState } from "react";
import { type Row, text } from "../types.js";
import { DiffList } from "./DiffView.js";
import { type FileDiff, fileDiffs } from "./diff-data.js";
import { executionResult, resultLinks } from "./result-data.js";
import {
  collapseLines,
  images,
  isWebUrl,
  linkParts,
  locations,
  matchLines,
  outputText,
  toolSummary,
} from "./tool-data.js";

export function ExternalLink({ href, children }: { href: string; children: string }) {
  return (
    <a
      href={href}
      rel="noreferrer noopener"
      onClick={(event) => {
        event.preventDefault();
        void window.zoltDesktop?.openExternal?.(href).catch(() => {});
      }}
    >
      {children}
    </a>
  );
}
function Linked({ value }: { value: string }) {
  return (
    <>
      {linkParts(value).map((part, index) =>
        part.href ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: Parts are derived from immutable text.
          <ExternalLink key={index} href={part.href}>
            {part.text}
          </ExternalLink>
        ) : (
          part.text
        ),
      )}
    </>
  );
}
/** Plain output with its head visible; the rest is one click away. */
export function CollapsedOutput({
  value,
  className = "",
  links = false,
  label = "Output",
}: {
  value: string;
  className?: string;
  links?: boolean;
  label?: string;
}) {
  const [all, setAll] = useState(false);
  if (!value.trim()) return null;
  const collapsed = collapseLines(value);
  const shown = all ? value.replace(/\n+$/, "") : collapsed.shown;
  return (
    <div className="tool-output">
      <pre
        className={className}
        title={label}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Bounded output scrolls and must support keyboard scrolling.
        tabIndex={0}
      >
        {links ? <Linked value={shown} /> : shown}
      </pre>
      {!all && collapsed.hidden ? (
        <button type="button" className="btn sm tool-more" onClick={() => setAll(true)}>
          Show {collapsed.hidden} more lines
        </button>
      ) : null}
    </div>
  );
}
export function ToolImages({ value }: { value: Row }) {
  const [expanded, setExpanded] = useState<number | undefined>();
  const sources = images(value.content, value.output);
  if (!sources.length) return null;
  return (
    <div className="tool-images">
      {sources.map((src, index) => (
        <button
          type="button"
          // biome-ignore lint/suspicious/noArrayIndexKey: Images keep their order in the output.
          key={index}
          className={`tool-image${expanded === index ? " expanded" : ""}`}
          aria-pressed={expanded === index}
          aria-label={`${expanded === index ? "Shrink" : "Enlarge"} image ${index + 1} from tool output`}
          onClick={() => setExpanded((current) => (current === index ? undefined : index))}
        >
          <img src={src} alt="" />
        </button>
      ))}
    </div>
  );
}
const outputOf = (value: Row) =>
  outputText(value.output !== undefined ? value.output : value.content);

export function ExecuteBody({ value }: { value: Row }) {
  const command = toolSummary(value);
  const { exitCode } = executionResult(value);
  return (
    <div className="tool-terminal">
      {command ? (
        <div className="tool-terminal-command mono">
          <span aria-hidden="true">$ </span>
          {command}
        </div>
      ) : null}
      {exitCode !== undefined ? <p className="tool-empty">Exit code {exitCode}</p> : null}
      <CollapsedOutput value={outputOf(value)} className="chat-terminal" />
      {value.status === "running" && !outputOf(value) ? (
        <p className="tool-empty">Waiting for output…</p>
      ) : null}
    </div>
  );
}
export function EditBody({ value, diffs }: { value: Row; diffs: FileDiff[] }) {
  return (
    <>
      {diffs.length ? <DiffList diffs={diffs} bare /> : <PathChips value={value} />}
      {value.status === "error" || value.status === "denied" || !diffs.length ? (
        <CollapsedOutput value={outputOf(value)} />
      ) : null}
    </>
  );
}
export function PathChips({ value }: { value: Row }) {
  const list = locations(value);
  if (!list.length) return null;
  return (
    <ul className="tool-paths" aria-label="Files">
      {list.slice(0, 20).map((location, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: A path can appear twice with other lines.
        <li key={index} className="tool-path mono" title={location.path}>
          {location.path}
          {location.line ? <span className="dim">:{location.line}</span> : null}
        </li>
      ))}
    </ul>
  );
}
export function ReadBody({ value }: { value: Row }) {
  return (
    <>
      <PathChips value={value} />
      <CollapsedOutput value={outputOf(value)} label="File content" />
    </>
  );
}
export function SearchBody({ value }: { value: Row }) {
  const { lines, more } = matchLines(outputOf(value));
  return (
    <div className="tool-search">
      {text(value.title) ? (
        <p className="tool-search-pattern">
          Pattern <code>{text(value.title)}</code>
        </p>
      ) : null}
      <PathChips value={value} />
      {lines.length ? (
        <ul
          className="tool-matches"
          aria-label="Matches"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: Bounded output scrolls and must support keyboard scrolling.
          tabIndex={0}
        >
          {lines.map((line, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: Match lines can repeat.
            <li key={index} className="mono truncate" title={line}>
              {line}
            </li>
          ))}
          {more ? <li className="dim">{more} more matches</li> : null}
        </ul>
      ) : value.status === "ok" ? (
        <p className="tool-empty">No matches.</p>
      ) : null}
    </div>
  );
}
export function FetchBody({ value }: { value: Row }) {
  const target = toolSummary(value);
  return (
    <>
      <p className="tool-fetch-target">
        {isWebUrl(target) ? (
          <ExternalLink href={target.trim()}>{target.trim()}</ExternalLink>
        ) : (
          <>
            Query <q>{target}</q>
          </>
        )}
      </p>
      <CollapsedOutput value={outputOf(value)} links />
    </>
  );
}
export function GenericBody({ value }: { value: Row }) {
  const raw = value.diffs;
  const diffs = useMemo(() => fileDiffs(raw), [raw]);
  return (
    <>
      {resultLinks(value).map((link) => (
        <div className="tool-result-link" key={link.url}>
          <ExternalLink href={link.url}>{link.label}</ExternalLink>
          <span className="dim sm">{new URL(link.url).hostname}</span>
          {link.description ? <p>{link.description}</p> : null}
        </div>
      ))}
      {value.input !== undefined ? (
        <>
          <div className="sec">Input</div>
          <pre>{outputText(value.input)}</pre>
        </>
      ) : null}
      {outputOf(value) ? (
        <>
          <div className="sec">Output</div>
          <CollapsedOutput value={outputOf(value)} className="chat-terminal" />
        </>
      ) : null}
      {diffs.length ? <DiffList diffs={diffs} open={false} /> : null}
    </>
  );
}
