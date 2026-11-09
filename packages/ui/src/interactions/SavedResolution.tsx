import type { Interaction } from "@zoltbot/protocol";
import { body, type ChatConnection } from "../chat/types.js";

export function SavedResolution({
  request,
  connection,
}: {
  request: Interaction;
  connection: ChatConnection;
}) {
  const resolution = request.resolution;
  const uncertain = connection.snapshot.entities.item?.some(
    (item) =>
      item.threadId === request.threadId &&
      body(item).code === "interaction_reply_failed" &&
      body(item).interactionId === request.id,
  );
  return (
    <section aria-label="Saved resolution">
      <h3>
        {request.state === "answered"
          ? "Answered"
          : request.state === "expired"
            ? "This request expired"
            : "This request was cancelled"}
      </h3>
      <p>
        {resolution
          ? `${resolution.by.kind}: ${resolution.by.id}${resolution.device ? ` · ${resolution.device}` : ""} · ${resolution.action}${resolution.choice ? ` · ${resolution.choice.replaceAll("_", " ")}` : ""}`
          : "Resolution details are not available."}
      </p>
      {uncertain ? (
        <p className="interaction-error" role="alert">
          Your answer was saved, but native delivery was not confirmed. Review the native session
          before continuing.
        </p>
      ) : null}
      {resolution?.feedback ? <p>{resolution.feedback}</p> : null}
      <dl>
        {request.items.map((item) => {
          const answer = resolution?.answers?.[item.id];
          if (!answer) return null;
          const labels = (item.options ?? [])
            .filter((option) => answer.options?.includes(option.id))
            .map((option) => option.label);
          return (
            <div key={item.id}>
              <dt>{item.prompt}</dt>
              <dd>
                {item.secret
                  ? "Private answer stored"
                  : [
                      ...labels,
                      answer.other ?? "",
                      answer.value !== undefined ? JSON.stringify(answer.value) : "",
                    ]
                      .filter(Boolean)
                      .join(", ")}
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}
