import { methodCatalog, parse } from "@zoltbot/protocol";
import { useEffect, useState } from "react";
import type { ChatConnection } from "./types.js";

export function MentionPicker({
  connection,
  threadId,
  query,
  id,
  onPick,
  onDismiss,
}: {
  connection: ChatConnection;
  threadId: string;
  query: string;
  id: string;
  onPick(file: { path: string; label: string }): void;
  onDismiss(): void;
}) {
  const { call, status } = connection;
  const [result, setResult] = useState<{
    query: string;
    items: { path: string; label: string }[];
    truncated: boolean;
  }>();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setError("");
    setResult(undefined);
    if (status !== "online") {
      setError("Reconnect to browse workspace files.");
      return;
    }
    const timer = setTimeout(() => {
      void call("workspace.files", { threadId, query, limit: 20 })
        .then((value) => {
          if (active)
            setResult({ ...parse(methodCatalog["workspace.files"].result, value), query });
        })
        .catch((error: unknown) => {
          if (active)
            setError(
              error instanceof Error && error.message.includes("workspace_not_ready")
                ? "Start a native session to browse its workspace. You can still use Attach."
                : "Workspace files are unavailable. You can still use Attach.",
            );
        });
    }, 150);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [call, status, threadId, query]);
  const ready = result?.query === query;
  return (
    <section
      id={id}
      className="chat-mentions"
      aria-label="Workspace files"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onDismiss();
          return;
        }
        if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
        const buttons = [
          ...event.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-file]"),
        ];
        const index = buttons.indexOf(event.target as HTMLButtonElement);
        if (!buttons.length) return;
        event.preventDefault();
        buttons[
          (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length
        ]?.focus();
      }}
    >
      <div className="r">
        <strong>Workspace files</strong>
        <span className="sp" />
        <button type="button" className="btn sm" aria-label="Close file picker" onClick={onDismiss}>
          Close
        </button>
      </div>
      {error ? (
        <output>{error}</output>
      ) : !ready ? (
        <output>Finding files…</output>
      ) : (
        <>
          {result.items.length ? (
            <ul>
              {result.items.map((file) => (
                <li key={file.path}>
                  <button
                    data-file
                    data-picker-option
                    type="button"
                    title={file.label}
                    onClick={() => onPick(file)}
                  >
                    {file.label}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <output>No matching files.</output>
          )}
          {result.truncated ? (
            <p className="dim sm">
              Showing a bounded selection. Type more of the file path to narrow it.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
