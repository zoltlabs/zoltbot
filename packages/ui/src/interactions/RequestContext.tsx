import type { Interaction } from "@zoltbot/protocol";
import { type RefObject, useMemo } from "react";
import { DictationControl, type useDictation } from "../chat/Dictation.js";
import { Markdown } from "../chat/Markdown.js";
import { DiffList } from "../chat/tools/DiffView.js";
import { fileDiffs } from "../chat/tools/diff-data.js";

/** What the request is about: plan or reason text, the exact command, paths, network, diffs. */
export function RequestContext({ request }: { request: Interaction }) {
  const context = request.context;
  const raw = context?.diffs;
  // Keyed on the raw diffs so typing feedback in the card never re-diffs.
  const diffs = useMemo(() => fileDiffs(raw), [raw]);
  if (!context) return null;
  return (
    <>
      {context.markdown ? <Markdown value={context.markdown} /> : null}
      {context.command ? (
        <section>
          <h3>Command</h3>
          <pre className="interaction-code">{context.command}</pre>
        </section>
      ) : null}
      {context.cwd ? (
        <p className="sm">
          Directory <code>{context.cwd}</code>
        </p>
      ) : null}
      {context.network ? (
        <p>
          Network <strong>{context.network.host}</strong> · {context.network.protocol}
        </p>
      ) : null}
      {context.paths?.length ? (
        <ul>
          {context.paths.map((path) => (
            <li key={path}>
              <code>{path}</code>
            </li>
          ))}
        </ul>
      ) : null}
      {diffs.length ? (
        <section className="interaction-diffs" aria-label="Proposed changes">
          <DiffList diffs={diffs} />
        </section>
      ) : null}
    </>
  );
}

export function FeedbackField({
  id,
  value,
  onChange,
  inputRef,
  dictation,
  disabled,
  placeholder,
}: {
  id: string;
  value: string;
  onChange(value: string): void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  dictation: ReturnType<typeof useDictation>;
  disabled: boolean;
  placeholder?: string;
}) {
  return (
    <div className="interaction-other">
      <div className="r wrap">
        <label htmlFor={id}>Feedback</label>
        <span className="sp" />
        <DictationControl dictation={dictation} disabled={disabled} label="Dictate feedback" />
      </div>
      <textarea
        id={id}
        ref={inputRef}
        disabled={disabled}
        value={value}
        onKeyDown={(event) => {
          dictation.handleKeyDown(event);
        }}
        onKeyUp={(event) => {
          dictation.handleKeyUp(event);
        }}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
    </div>
  );
}
