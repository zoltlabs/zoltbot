import { useId } from "react";
import { type OverheadMetrics, overheadData } from "./overhead-data.js";
import type { Row } from "./types.js";

const count = (value: number | undefined) =>
  value === undefined ? "Not reported" : `${value.toLocaleString()} tokens`;
const percent = (value: number | undefined) =>
  value === undefined
    ? "Not reported"
    : `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
function Metrics({ title, value }: { title: string; value: OverheadMetrics | undefined }) {
  return (
    <section aria-label={title}>
      <h3>{title}</h3>
      <dl>
        <div>
          <dt>Added by Zoltbot</dt>
          <dd>{count(value?.injectedTokens)}</dd>
        </div>
        <div>
          <dt>Provider input</dt>
          <dd>{count(value?.inputTokens)}</dd>
        </div>
        <div>
          <dt>Share of input</dt>
          <dd>{percent(value?.percent)}</dd>
        </div>
        <div>
          <dt>Cache hit ratio</dt>
          <dd>{percent(value?.cacheRatio === undefined ? undefined : value.cacheRatio * 100)}</dd>
        </div>
      </dl>
    </section>
  );
}
export function Overhead({
  rows,
  sessionId,
  turnId,
  compact = false,
}: {
  compact?: boolean;
  rows: readonly Row[];
  sessionId: string | undefined;
  turnId: string | undefined;
}) {
  const id = useId(),
    data = overheadData(rows, sessionId, turnId);
  return (
    <section
      className={`chat-context-section chat-overhead${compact ? " chat-overhead-compact" : ""}`}
      aria-labelledby={id}
    >
      <h3 id={id}>Added context</h3>
      {data.session?.injectedTokens !== undefined ? (
        <p className="chat-metric">{count(data.session.injectedTokens)}</p>
      ) : null}
      <details>
        <summary>
          {compact ? `Added context: ${count(data.session?.injectedTokens)}` : "Overhead details"}
        </summary>
        <p className="dim sm">Instructions and generated context are counted separately.</p>
        <Metrics title="Current or latest turn" value={data.turn} />
        <Metrics title="Current session" value={data.session} />
        <p className="dim sm">
          Added tokens use a local reference estimate. Input and cache counts come from your coding
          tool when reported. Missing counts stay unknown.
        </p>
      </details>
    </section>
  );
}
