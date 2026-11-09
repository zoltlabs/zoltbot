import type { QuickMessage, QuickRequest } from "@zoltbot/protocol";
import { useState } from "react";
import { ActivityDetails } from "../chat/ActivityDetails.js";
import { runningToolLabel } from "../chat/activity-data.js";
import { Button } from "../components/primitives.js";
import { errorText, type QuickConnectionProp, requestOutcome, toolName } from "./data.js";

/** What a reply looked up, and the requests it is waiting on before it acts. */
export function QuickRequests({
  message,
  connection,
}: {
  message: QuickMessage;
  connection: QuickConnectionProp;
}) {
  const tools = message.tools ?? [];
  const active =
    message.status === "streaming"
      ? tools.findLast((tool) => tool.status === "running")
      : undefined;
  const failed = tools.some((tool) => tool.status === "error" || tool.status === "denied");
  const waiting = message.requests?.some((request) => request.state === "pending");
  const resolved = message.requests?.filter((request) => request.state !== "pending") ?? [];
  const running = message.status === "streaming" && !waiting;
  const label = failed
    ? "A step failed"
    : waiting
      ? "Waiting for you"
      : active
        ? runningToolLabel(active)
        : running
          ? message.text
            ? "Writing…"
            : "Thinking…"
          : tools.length
            ? `${tools.length} ${tools.length === 1 ? "step" : "steps"}`
            : "Saved decisions";
  return (
    <>
      {tools.length || resolved.length ? (
        <ActivityDetails label={label} running={running} failed={failed} waiting={!!waiting}>
          <ul aria-label="Activity steps">
            {tools.map((tool) => (
              <li key={tool.id}>
                <span>{tool.title || toolName(tool.name)}</span>
                <span>
                  {tool.status === "running"
                    ? "Working"
                    : tool.status === "error"
                      ? "Failed"
                      : tool.status === "denied"
                        ? "Denied"
                        : "Done"}
                </span>
              </li>
            ))}
            {resolved.map((request) => (
              <li key={request.id}>
                <RequestCard request={request} replyId={message.id} connection={connection} />
              </li>
            ))}
          </ul>
        </ActivityDetails>
      ) : running || waiting ? (
        <output className="activity-details">{label}</output>
      ) : null}
      {message.requests
        ?.filter((request) => request.state === "pending")
        .map((request) => (
          <RequestCard
            key={request.id}
            request={request}
            replyId={message.id}
            connection={connection}
          />
        ))}
    </>
  );
}
function RequestCard({
  request,
  replyId,
  connection,
}: {
  request: QuickRequest;
  replyId: string;
  connection: QuickConnectionProp;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const answer = async (decision: "allow" | "always" | "deny", optionId?: string) => {
    setBusy(true);
    setError("");
    try {
      await connection.call(
        "quickChat.respond",
        { replyId, requestId: request.id, decision, ...(optionId ? { optionId } : {}) },
        `quick-respond-${crypto.randomUUID()}`,
      );
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };
  if (request.state !== "pending")
    return (
      <p className="quick-request-done quick-muted">
        {requestOutcome[request.state]}: {request.title}
      </p>
    );
  return (
    <section className="quick-request" aria-label="Request waiting for you">
      <p className="quick-request-title">{request.title}</p>
      {request.toolName ? <p className="quick-muted">Tool: {toolName(request.toolName)}</p> : null}
      {request.detail ? <pre className="quick-request-detail">{request.detail}</pre> : null}
      <div className="quick-request-actions">
        {request.kind === "question" ? (
          request.options?.map((option) => (
            <Button
              key={option.id}
              size="sm"
              disabled={busy}
              onClick={() => void answer("allow", option.id)}
            >
              {option.label}
            </Button>
          ))
        ) : (
          <>
            <Button
              size="sm"
              variant="primary"
              disabled={busy}
              onClick={() => void answer("allow")}
            >
              Allow once
            </Button>
            {request.toolName ? (
              <Button size="sm" disabled={busy} onClick={() => void answer("always")}>
                Always allow
              </Button>
            ) : null}
          </>
        )}
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void answer("deny")}>
          {request.kind === "question" ? "Skip" : "Deny"}
        </Button>
      </div>
      {error ? (
        <p className="quick-muted" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
