import "./artifacts.css";
import { compareSessions, type OutputMode, outputModes } from "@zoltbot/protocol";
import type { ChatConnection } from "../chat/types.js";
export function artifactOutputAvailable(connection: ChatConnection, threadId: string) {
  const session = connection.snapshot.entities.session
    ?.filter((s) => s.threadId === threadId)
    .sort(compareSessions)[0];
  if (!session) return true;
  const saved = connection.snapshot.entities.settings?.find(
    (s) => s.key === `runtime.configuration.${String(session.id)}`,
  )?.value as { launchManifest?: { artifact?: unknown } } | undefined;
  return Boolean(saved?.launchManifest?.artifact);
}
export function artifactRevisionAvailable(connection: ChatConnection, threadId: string) {
  const thread = connection.snapshot.entities.thread?.find((row) => row.id === threadId);
  if (!thread || thread.taskId || thread.archived) return false;
  const session = connection.snapshot.entities.session
    ?.filter((s) => s.threadId === threadId)
    .sort(compareSessions)[0];
  const saved = connection.snapshot.entities.settings?.find(
    (s) => s.key === `runtime.configuration.${String(session?.id)}`,
  )?.value as { launchManifest?: { artifact?: { sourceRead?: number } } } | undefined;
  return saved?.launchManifest?.artifact?.sourceRead === 1;
}
export function OutputControl({
  value,
  onChange,
  disabled = false,
  legacy = false,
}: {
  value: OutputMode;
  onChange(value: OutputMode): void;
  disabled?: boolean;
  legacy?: boolean;
}) {
  return (
    <label className="artifact-output-control">
      <span className="artifact-output-label">Output</span>
      <select
        aria-label="Output"
        value={value}
        disabled={disabled || legacy}
        title={
          legacy
            ? "Start a new conversation to use artifact Output choices."
            : "Choose the output for this message."
        }
        onChange={(event) => onChange(event.target.value as OutputMode)}
      >
        {outputModes.map((mode) => (
          <option key={mode.value} value={mode.value}>
            {mode.label}
          </option>
        ))}
      </select>
    </label>
  );
}
