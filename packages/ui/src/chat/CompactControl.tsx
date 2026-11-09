import { useId, useRef, useState } from "react";
import { Button, SectionLabel } from "../components/primitives.js";
import type { ChatConnection } from "./types.js";

/** Manual compaction, offered only when the session reports compaction.manual. */
export function CompactControl({
  connection,
  sessionId,
  available,
  ready,
  onError,
}: {
  connection: ChatConnection;
  sessionId: string | undefined;
  /** capabilities.compaction.manual */
  available: boolean;
  /** The session is ready and no turn is running. */
  ready: boolean;
  onError(message: string): void;
}) {
  const id = useId();
  const [instructions, setInstructions] = useState(""),
    [compacting, setCompacting] = useState(false);
  const attempt = useRef<{ key: string; id: string } | undefined>(undefined);
  const compact = async () => {
    if (!sessionId) return;
    const trimmed = instructions.trim();
    const key = JSON.stringify([sessionId, trimmed]);
    if (attempt.current?.key !== key) attempt.current = { key, id: crypto.randomUUID() };
    setCompacting(true);
    onError("");
    try {
      await connection.call(
        "session.compact",
        { id: sessionId, ...(trimmed ? { instructions: trimmed } : {}) },
        attempt.current.id,
      );
      attempt.current = undefined;
      setInstructions("");
    } catch {
      onError("Compaction could not be confirmed. Review the native session before trying again.");
    } finally {
      setCompacting(false);
    }
  };
  if (!available) return null;
  return (
    <section className="chat-context-section" aria-label="Compaction">
      <SectionLabel>Compaction</SectionLabel>
      <p className="chat-context-hint">
        {available
          ? "Your coding tool manages its context. Manual compaction can make the next turn use a cold cache."
          : "Your coding tool manages its context and does not offer manual compaction."}
      </p>
      {available ? (
        <label className="chat-compact-instructions" htmlFor={`${id}-instructions`}>
          Focus for the summary (optional)
          <textarea
            id={`${id}-instructions`}
            rows={2}
            maxLength={2000}
            value={instructions}
            disabled={compacting}
            placeholder="Keep the API decisions and open questions"
            onChange={(event) => setInstructions(event.target.value)}
          />
        </label>
      ) : null}
      <Button
        size="sm"
        disabled={
          !sessionId || !ready || compacting || !available || connection.status !== "online"
        }
        onClick={() => void compact()}
      >
        {compacting ? "Compacting…" : "Compact now"}
      </Button>
    </section>
  );
}
