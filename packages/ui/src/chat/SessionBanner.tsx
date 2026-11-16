import { useRef, useState } from "react";
import { useShell } from "../state.js";
import { ProviderAccess } from "./ProviderAccess.js";
import { type Recovery, sessionRecovery } from "./session-recovery.js";
import { body, type ChatConnection, type Row, text } from "./types.js";
import { waitingState } from "./waiting-state.js";

export function SessionBanner({
  connection,
  threadId,
  session,
  items,
}: {
  connection: ChatConnection;
  threadId: string;
  session: Row | undefined;
  items: Row[];
}) {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Recovery>();
  const attempt = useRef<string | undefined>(undefined);
  const uncertain = items.some(
    (row) => row.kind === "user" && body(row).queueState === "uncertain",
  );
  const waiting = waitingState(connection.snapshot.entities, threadId, connection.status);
  const reason = text(session?.endReason);
  let recovery: Recovery | undefined;
  if (reason === "runtime_cleanup_required" || reason === "native_start_uncertain")
    recovery = sessionRecovery(reason);
  else if (uncertain)
    recovery = {
      title: "Check message delivery",
      description:
        "This message may already have reached the coding tool. Check its session before retrying.",
      route: "Doctor",
      label: "Check coding agent",
    };
  else if (connection.status !== "online")
    recovery = {
      title: "Host disconnected",
      description: "Reconnecting… Your draft stays here.",
    };
  else if (session && ["closed", "failed"].includes(text(session.state)))
    recovery = sessionRecovery(reason);
  else if (waiting?.kind === "provider")
    recovery = {
      title: waiting.label,
      description: waiting.description,
      ...(waiting.label === "Sign-in required" ? { reconnect: true } : {}),
    };
  // A new chat starts on Send. ModelPicker offers an explicit connection to discover models early.
  const shown = failure ?? recovery;
  if (!shown) return null;
  const thread = connection.snapshot.entities.thread?.find((row) => row.id === threadId);
  const profile = connection.snapshot.entities.agent?.find((row) => row.id === thread?.agentId);
  const auth = reason === "auth_required" || waiting?.label === "Sign-in required";
  return (
    <section className="chat-session-banner" aria-label="Conversation status">
      <div className="chat-recovery-content">
        <div aria-live="polite">
          <strong>{shown.title}</strong>
          <p>{shown.description}</p>
        </div>
        {auth && profile ? (
          <ProviderAccess
            key={text(profile.id)}
            connection={connection}
            profileId={text(profile.id)}
            provider={text(profile.definitionId)}
          />
        ) : null}
        {failure ? <p role="alert">The connection could not be restored.</p> : null}
      </div>
      <div className="chat-recovery-actions">
        {shown.route ? (
          <button
            type="button"
            className="btn sm"
            onClick={() => {
              if (shown.route) useShell.getState().navigate(shown.route);
            }}
          >
            {shown.label}
          </button>
        ) : null}
        {shown.reconnect ? (
          <button
            type="button"
            className="btn sm"
            disabled={pending || connection.status !== "online"}
            onClick={async () => {
              setPending(true);
              setFailure(undefined);
              attempt.current ??= crypto.randomUUID();
              try {
                await connection.call(
                  "session.connect",
                  { threadId, ...(session ? { previousSessionId: session.id } : {}) },
                  attempt.current,
                );
                attempt.current = undefined;
              } catch (cause) {
                setFailure(sessionRecovery(cause instanceof Error ? cause.message : ""));
              } finally {
                setPending(false);
              }
            }}
          >
            {pending ? "Reconnecting…" : "Reconnect"}
          </button>
        ) : null}
      </div>
    </section>
  );
}
