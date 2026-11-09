import { parse, RoutineSchema } from "@zoltbot/protocol";
import type { ChatConnection } from "../chat/types.js";
import { Button } from "../components/primitives.js";
import { useShell } from "../state.js";

/** Metadata-only handoff into the existing Connections surface. No OAuth completion is implied. */
export function RoutineConnectionReturn({ connection }: { connection: ChatConnection }) {
  const navigate = useShell((s) => s.navigate);
  const openThread = useShell((s) => s.openThread);
  const rows = connection.snapshot.entities;
  const handoffs = (rows.settings ?? [])
    .filter((row) => String(row.key).startsWith("routine.handoff."))
    .map(
      (row) =>
        row.value as {
          reference: string;
          routineId: string;
          revision: number;
          chatId?: string;
          createdAt: string;
        },
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (!handoffs.length) return null;
  return (
    <section className="zb-card settings-panel" aria-label="Routine connection drafts">
      <h2>Return to your routine</h2>
      <p>
        Drafts stay saved while you review Connections. Agent tools and event delivery need separate
        authorization. Sentry event delivery is not available yet.
      </p>
      {handoffs.slice(0, 5).map((handoff) => {
        const raw = rows.routine?.find((row) => row.id === handoff.routineId);
        if (!raw) return null;
        const routine = parse(RoutineSchema, raw);
        const unchanged = routine.event?.revision === handoff.revision;
        const chat = rows.thread?.find(
          (row) =>
            row.id === handoff.chatId &&
            !row.archived &&
            JSON.stringify(row.node) === JSON.stringify(routine.template.node),
        );
        return (
          <div key={handoff.reference}>
            <h3>{routine.name}</h3>
            <p>
              {unchanged
                ? "Your brief and selections are preserved. Nothing is enabled by connecting tools."
                : "This routine changed. Review its latest draft before continuing."}
            </p>
            <Button onClick={() => (chat ? openThread(String(chat.id)) : navigate("Routines"))}>
              {chat ? "Return to chat draft" : "Review draft in Routines"}
            </Button>
          </div>
        );
      })}
    </section>
  );
}
