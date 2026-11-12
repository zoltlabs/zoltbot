import { type Interaction, InteractionSchema, parse } from "@zoltbot/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatConnection } from "../chat/types.js";
import { InteractionCard } from "./InteractionCard.js";
import { selectedRequest } from "./request-presentation.js";

export default function PendingInteraction({
  connection,
  threadId,
  profile,
  label = "Pending request",
  inline,
}: {
  connection: ChatConnection;
  threadId: string;
  profile: string;
  label?: string;
  /** Approvals already shown in the conversation where the tool would run. */
  inline?: ReadonlySet<string>;
}) {
  const [revealed, setRevealed] = useState(false);
  const previous = useRef<string | undefined>(undefined);
  const entities = connection.snapshot.entities;
  const requests = useMemo(() => {
    const result: Interaction[] = [];
    for (const row of entities.interaction ?? []) {
      if (row.threadId !== threadId || row.state !== "pending") continue;
      if (row.type === "approval" && inline?.has(String(row.id))) continue;
      try {
        result.push(parse(InteractionSchema, row));
      } catch {}
    }
    return result;
  }, [entities.interaction, threadId, inline]);
  const setting = entities.settings?.find((row) => row.key === "interaction.deferred")?.value;
  const deferred = new Set(Array.isArray(setting) ? setting : []);
  const [selected, setSelected] = useState<string>();
  const current = selectedRequest(
    requests.filter((request) => revealed || !deferred.has(request.id)),
    selected,
  );
  useEffect(() => setSelected(current?.id), [current?.id]);
  useEffect(() => {
    if (previous.current && !current?.id)
      document.querySelector<HTMLTextAreaElement>(".chat-composer textarea")?.focus();
    previous.current = current?.id;
  }, [current?.id]);
  if (!current)
    return requests.length ? (
      <div className="chat-held-request">
        <button type="button" className="btn" onClick={() => setRevealed(true)}>
          Open {requests.length} pending request{requests.length === 1 ? "" : "s"}
        </button>
      </div>
    ) : null;
  return (
    <section className="chat-pending-request" aria-label={label}>
      <InteractionCard
        key={current.id}
        request={current}
        connection={connection}
        profile={profile}
        onDeferred={() => {
          setRevealed(false);
          document.querySelector<HTMLTextAreaElement>(".chat-composer textarea")?.focus();
        }}
      />
    </section>
  );
}
