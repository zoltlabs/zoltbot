import { memo } from "react";
import { Avatar } from "../components/primitives.js";
import { Icon } from "../shell/icons.js";
import { Markdown } from "./Markdown.js";
import { MessageDetails } from "./MessageDetails.js";
import { type MessageSource, unknownSource } from "./sources.js";
import { planEntries, planProgress } from "./timeline-data.js";
import { ToolRow } from "./tools/ToolRow.js";
import { body, type Row, text } from "./types.js";

const number = new Intl.NumberFormat("en");
function keyed<T>(values: T[], identity: (value: T) => string) {
  const counts = new Map<string, number>();
  return values.map((value) => {
    const base = identity(value),
      occurrence = counts.get(base) ?? 0;
    counts.set(base, occurrence + 1);
    return { value, key: `${base}:${occurrence}` };
  });
}
function Usage({ usage }: { usage: Row }) {
  const cost =
    typeof usage.costUsd === "number"
      ? `${usage.costKnown === true ? "Reported" : "Estimated"} $${usage.costUsd.toFixed(4)}`
      : "Cost not reported";
  return (
    <div className="chat-usage">
      {typeof usage.inputTokens === "number" ? (
        <span>{number.format(usage.inputTokens)} in</span>
      ) : null}
      {typeof usage.outputTokens === "number" ? (
        <span>{number.format(usage.outputTokens)} out</span>
      ) : null}
      {typeof usage.cacheReadTokens === "number" &&
      typeof usage.inputTokens === "number" &&
      usage.inputTokens > 0 &&
      usage.cacheReadTokens <= usage.inputTokens ? (
        <span>{Math.round((100 * usage.cacheReadTokens) / usage.inputTokens)}% cache read</span>
      ) : null}
      <span>{cost}</span>
      {typeof usage.injectedTokens === "number" ? (
        <span>Zoltbot added {number.format(usage.injectedTokens)} tokens</span>
      ) : null}
    </div>
  );
}
export const MessageRow = memo(function MessageRow({
  item,
  name,
  usage,
  interaction,
  source,
  onRewind,
  onEdit,
  compareProfiles,
}: {
  compareProfiles?: { id: string; name: string }[] | undefined;
  item: Row;
  name: string;
  /** Who sent an agent-originated input, such as "From Planner (manager)", and its chat. */
  source?: MessageSource | undefined;
  usage?: Row | undefined;
  interaction?: Row | undefined;
  /** Present when the session can restore files to the state before this message. */
  onRewind?: ((item: Row) => void) | undefined;
  /** Starts a new chat from before this message with an edited copy of it. */
  onEdit?: ((item: Row) => void) | undefined;
}) {
  const value = body(item),
    kind = text(item.kind);
  if (kind === "note" && value.code === "compare")
    return (
      <article className="compare-marker" aria-label="Compare result">
        <span className="compare-marker-avatars">
          {compareProfiles?.map((p) => (
            <Avatar key={p.id} id={p.id} name={p.name} size={20} />
          ))}
        </span>
        <strong>
          Compared {String(value.count)} answers · continued with {name}
        </strong>
        <p>The other answers are kept as side chats.</p>
        <a href={`#compare/${encodeURIComponent(text(value.compareId))}`}>View side by side</a>
      </article>
    );
  if (kind === "user") {
    const parts = Array.isArray(value.input) ? (value.input as Row[]) : [];
    // Zoltbot's own notices to an agent (a wake-up, a result to act on) are events, not your words.
    const first = parts[0]?.type === "text" ? text(parts[0].text) : "";
    if (value.origin !== "agent" && first.startsWith("[Zoltbot] ")) {
      const woke = text(item.id).startsWith("chief-wake:"),
        brief = text(item.id).startsWith("chief-wake:brief:");
      const lines = first.slice("[Zoltbot] ".length).split("\n");
      // A wake-up's first line only tells the agent it is one; the rest is why.
      const details = (woke ? lines.slice(1) : lines).join("\n").trim();
      return (
        <article
          className="chat-system-event"
          aria-label={brief ? "Morning brief" : woke ? "Wake-up" : "Zoltbot notice"}
        >
          <Icon name={woke ? "Chief" : "Info"} size="sm" />
          {woke ? (
            <details>
              <summary>{brief ? "Morning brief" : "Woke up on its own"}</summary>
              <p>{details}</p>
            </details>
          ) : (
            <p>{details}</p>
          )}
        </article>
      );
    }
    const from = value.origin === "agent" ? source?.label || unknownSource : undefined;
    return (
      <article className="chat-message chat-human" aria-label={from ?? "Your message"}>
        {/* Your own messages need no name; only a message another chat sent says who. */}
        {from ? (
          <div className="chat-message-label">
            {source?.threadId ? (
              <a href={`#chat/${encodeURIComponent(source.threadId)}`}>{from}</a>
            ) : (
              from
            )}
          </div>
        ) : null}
        <div className="chat-human-bubble">
          {value.artifactTarget && typeof value.artifactTarget === "object" ? (
            <p className="dim">
              Artifact reference: {text((value.artifactTarget as Row).versionId)}
            </p>
          ) : null}
          {keyed(parts, (part) => `${part.type}:${text(part.path) || text(part.text)}`).map(
            ({ value: part, key }) =>
              part.type === "text" ? (
                <p key={key}>{text(part.text)}</p>
              ) : (
                <span className="chat-attachment" key={key}>
                  {part.type === "image" ? "Image" : "File"}:{" "}
                  {text(part.path).split(/[\\/]/).at(-1) || "Attachment"}
                </span>
              ),
          )}
        </div>
        <div
          className={`chat-message-label chat-human-footer${["sent", "handled", undefined].includes(value.queueState as string | undefined) ? " message-secondary" : ""}`}
        >
          {onEdit &&
          value.origin !== "agent" &&
          typeof item.turnId === "string" &&
          ["sent", "handled", undefined].includes(value.queueState as string | undefined) ? (
            <button
              type="button"
              className="btn sm ghost chat-rewind"
              aria-label="Edit and send again…"
              title="Start a new chat from here with an edited copy of this message"
              onClick={() => onEdit(item)}
            >
              <Icon name="Edit" size="sm" />
              Edit…
            </button>
          ) : null}
          {onRewind &&
          value.origin !== "agent" &&
          typeof item.turnId === "string" &&
          ["sent", "handled", undefined].includes(value.queueState as string | undefined) ? (
            <button
              type="button"
              className="btn sm ghost chat-rewind"
              aria-label="Rewind to before this message…"
              title="Restore code or fork the conversation from before this message"
              onClick={() => onRewind(item)}
            >
              <Icon name="Rewind" size="sm" />
              Rewind…
            </button>
          ) : null}
          {value.queueState === "queued"
            ? "Queued"
            : value.queueState === "sending"
              ? "Sending"
              : value.queueState === "uncertain"
                ? "Delivery needs review"
                : value.queueState === "failed"
                  ? value.errorCode === "cancelled"
                    ? "Cancelled"
                    : "Not sent"
                  : value.deliveryMode === "steer"
                    ? "Steered"
                    : value.queueState === "handled"
                      ? "Command handled"
                      : null}
        </div>
      </article>
    );
  }
  if (kind === "message" || kind === "thought") {
    const content = (
      <>
        <Markdown value={text(value.text)} />
        {value.partial === true ? (
          <p className="dim sm">
            This message ended before completion. Native history may contain more detail.
          </p>
        ) : null}
        {item.phase === "final" && usage ? (
          <MessageDetails>
            <Usage usage={usage} />
          </MessageDetails>
        ) : null}
      </>
    );
    return (
      <article
        className={`chat-message${kind === "thought" ? " chat-thought" : ""}`}
        aria-label={kind === "thought" ? `${name} thinking` : `Message from ${name}`}
        aria-busy={value.streaming === true}
      >
        {kind === "thought" ? (
          <details>
            <summary className="chat-message-label">
              Reasoning{value.streaming === true ? " · thinking" : ""}
            </summary>
            {content}
          </details>
        ) : (
          // Replies carry no author line; the chat header already says who answers.
          content
        )}
      </article>
    );
  }
  if (kind === "tool")
    return <ToolRow id={text(item.id)} value={value} interaction={interaction} />;
  if (kind === "plan") {
    const progress = planProgress(planEntries(item));
    return (
      <article className="chat-note chat-plan-note" aria-label="To-do update">
        <Icon name="Todo" size="sm" />
        Updated to-do list
        {progress.total ? (
          <span className="dim">
            {" "}
            · {progress.done}/{progress.total} done
          </span>
        ) : null}
      </article>
    );
  }
  if (kind === "interaction")
    return (
      <article className="zb-card chat-request">
        <span className={`chip${interaction?.state === "pending" ? " need" : ""}`}>
          {interaction?.state === "pending"
            ? "Needs you"
            : interaction?.state === "answered"
              ? "Answered"
              : interaction?.state === "expired"
                ? "Expired"
                : interaction?.state === "cancelled"
                  ? "Cancelled"
                  : "Status unavailable"}
        </span>
        <span>
          {interaction?.state === "pending"
            ? "A question or approval is waiting."
            : "Review this request’s saved state in the Inbox."}
        </span>
        <a className="btn" href="#inbox">
          {interaction?.state === "pending" ? "Open request" : "View request"}
        </a>
      </article>
    );
  return (
    <article className="chat-note" aria-label="Session note">
      {text(value.text) ||
        (value.code === "context_compacted"
          ? "Context compacted by your coding tool."
          : value.code === "manual_compaction"
            ? `Manual compaction: ${text(value.state)}`
            : "Session update")}
    </article>
  );
});
