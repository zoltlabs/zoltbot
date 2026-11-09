import { useState } from "react";
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
  const [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const uncertain = items.some(
    (row) => row.kind === "user" && body(row).queueState === "uncertain",
  );
  const reason = text(session?.endReason);
  const waiting = waitingState(connection.snapshot.entities, threadId, connection.status);
  let title = "",
    description = "",
    action = "",
    note = false;
  if (reason === "runtime_cleanup_required") {
    title = "Session cleanup needs review";
    description =
      "The previous coding tool process has not confirmed it stopped. Review that process before opening another session.";
  } else if (uncertain) {
    title = "Message delivery needs review";
    description =
      "A saved message may already have reached your coding tool. Check the native session before retrying. Zoltbot will not resend it automatically.";
  } else if (waiting && ["connection", "provider"].includes(waiting.kind)) {
    note = true;
    description = waiting.description;
    if (waiting.label === "Sign-in required") action = "Reconnect";
    else if (
      waiting.label === "Coding tool needs attention" &&
      ["closed", "failed"].includes(text(session?.state))
    )
      action = "Reconnect";
  } else if (!session) {
    // D082: connecting records a human intent, so it is never automatic. Sending already opens
    // the session (turn.send wakes the runtime), so Connect only loads commands and modes early.
    note = true;
    description =
      "Your coding tool starts when you send a message. Connect now to load its commands and modes first.";
    action = "Connect";
  } else if (session.state === "starting") {
    title = "Connecting to your coding tool…";
    description = "Waiting for the native session to become ready.";
  } else if (["closed", "failed"].includes(text(session.state))) {
    action = "Reconnect";
    if (reason === "auth_required") {
      title = "Not signed in";
      description = "Sign in using your coding tool, then reconnect this conversation.";
    } else if (reason === "read_only_mode_unavailable") {
      title = "Read-only mode unavailable";
      description =
        "This coding tool does not advertise a read-only mode. Choose a compatible profile, or start a new chat with workspace-write permissions.";
      action = "";
    } else if (reason === "http_mcp_not_supported") {
      title = "Host tools unavailable";
      description =
        "This coding tool version cannot connect to Zoltbot’s HTTP tools. Update the CLI and check its installation in Doctor.";
    } else if (["unsupported_model_selection", "unsupported_effort"].includes(reason)) {
      title = "Profile settings unavailable";
      description =
        "The selected model or effort is not offered by this coding tool. Update the profile settings before starting a new chat.";
      action = "";
    } else if (reason === "injection_budget_exceeded") {
      title = "Added context exceeded its budget";
      description =
        "Your message is saved. Review the added context and its limits before continuing.";
      action = "";
    } else if (reason === "daemon_restart") {
      title = "Session interrupted after restart";
      description =
        "Reconnect to the native session to continue. Saved history is available below.";
    } else if (
      [
        "runtime_process_error",
        "runtime_stream_ended",
        "runtime_event_failed",
        "runtime_dispatch_failed",
      ].includes(reason)
    ) {
      title = "Coding tool stopped unexpectedly";
      description =
        "Restart the native connection to continue this conversation. Completed history will not be resent.";
      action = "Restart";
    } else {
      title = "Native session disconnected";
      description = "Reconnect to continue with your coding tool’s native session.";
    }
  }
  if (!title && !note) return null;
  return (
    <section
      className={`chat-session-banner${note ? " note" : ""}`}
      aria-label="Conversation status"
      aria-live="polite"
    >
      <div>
        {title ? <strong>{title}</strong> : null}
        <p>{description}</p>
        {error ? <p role="alert">{error}</p> : null}
      </div>
      {action ? (
        <button
          type="button"
          className={note ? "btn sm" : "btn"}
          disabled={pending || connection.status !== "online"}
          onClick={async () => {
            setPending(true);
            setError("");
            try {
              await connection.call(
                "session.connect",
                { threadId, ...(session ? { previousSessionId: session.id } : {}) },
                crypto.randomUUID(),
              );
            } catch (cause) {
              const code = cause instanceof Error ? cause.message : "";
              const descriptions: Record<string, string> = {
                native_start_uncertain:
                  "Native startup was interrupted before its identity was saved. Check the provider's session list before adopting a session; Zoltbot will not start a duplicate automatically.",
                connection_revoked:
                  "Connection access was revoked. Review Settings → Connections, then start a new task. Your saved conversation remains available.",
                connection_credentials_unavailable:
                  "A connection needs sign-in. Reconnect it in Settings → Connections, then start a new task. Your draft and history are saved.",
                context_budget_hold:
                  "Session inputs exceed the context budget. Edit knowledge, exclude it for this execution, or narrow Connections and Skills before trying again.",
                connection_native_name_conflict:
                  "A native MCP name conflicts with a managed connection. Review the native MCP configuration before starting a new task.",
                host_mcp_name_conflict:
                  "The native MCP configuration already uses Zoltbot's reserved host name. Resolve that conflict before connecting.",
                native_skills_loading_unavailable:
                  "This provider cannot load the selected managed skills natively. Disable those skills for future sessions or choose a compatible profile.",
                binary_not_found:
                  "This coding tool could not be found. Check its installation or executable override.",
                binary_broken:
                  "This coding tool executable is broken. Choose a working installation.",
                read_only_mode_unavailable:
                  "This coding tool does not advertise a read-only mode. Choose a compatible profile or start a new chat with workspace-write permissions.",
                http_mcp_not_supported:
                  "Update this coding tool to a version with HTTP MCP support, then reconnect.",
                unsupported_model_selection:
                  "The selected model is not offered by this coding tool. Update the profile before starting a new chat.",
                unsupported_effort:
                  "The selected effort is not offered by this coding tool. Update the profile before starting a new chat.",
                auth_required: "Sign in with the command in Provider sign-in, then reconnect.",
                injection_fixed_budget_exceeded:
                  "The profile and inherited instructions are too long. Shorten them before starting a new conversation.",
                native_configuration_changed:
                  "This conversation’s provider configuration changed. Restore its original provider folder before resuming.",
                runtime_workspace_choice_required:
                  "Choose one code folder for this workspace before connecting.",
                runtime_workspace_unavailable:
                  "The selected working folder is unavailable. Restore the original folder before resuming.",
              };
              setError(
                descriptions[code] ??
                  (code === "runtime_private_context_required"
                    ? "This session needs its protected private context restored before it can reconnect."
                    : code === "runtime_cleanup_required"
                      ? "The previous process still needs review before another connection can open."
                      : "Connection could not be confirmed. Review the coding tool’s current state before trying again."),
              );
            } finally {
              setPending(false);
            }
          }}
        >
          {pending ? "Connecting…" : action}
        </button>
      ) : null}
    </section>
  );
}
