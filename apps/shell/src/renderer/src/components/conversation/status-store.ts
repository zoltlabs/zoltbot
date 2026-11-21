// C9: the open chat's working line: the agent's own words, or a line from the tool it runs. The
// line holds for at least 3 seconds so it reads calmly.
import { nextStatus } from "@zoltbot/protocol";
import { type Accessor, createEffect, createSignal, on, onCleanup, untrack } from "solid-js";

const [wanted, setWanted] = createSignal<{ botId?: string; text?: string }>({});
const [shown, setShown] = createSignal<{ text: string; at: number }>();

/** The line to show under the chat while its agent works. */
export const workingLine = () => shown()?.text;

/** Follows one chat's working line from conversation snapshots. */
export function watchWorkingLine(botId: Accessor<string | undefined>) {
  createEffect(
    on(botId, (id) => {
      setWanted({ botId: id });
      setShown(undefined);
      if (!id) return;
      void window.openbot.agent
        .readConversation(id)
        .then((snapshot) => {
          if (botId() === id) setWanted({ botId: id, text: snapshot.workingStatus ?? undefined });
        })
        .catch(() => undefined);
    }),
  );
  const stop = window.openbot.agent.onEvent((event) => {
    if (event.type === "conversation" && event.snapshot.botId === botId())
      setWanted({ botId: botId(), text: event.snapshot.workingStatus ?? undefined });
  });
  onCleanup(stop);
  let timer: number | undefined;
  createEffect(() => {
    const text = wanted().text;
    window.clearTimeout(timer);
    if (!text) return setShown(undefined);
    const apply = () => {
      const next = nextStatus(untrack(shown), text, Date.now());
      setShown({ text: next.text, at: next.at });
      if (next.waitMs !== undefined) timer = window.setTimeout(apply, next.waitMs);
    };
    apply();
  });
  onCleanup(() => window.clearTimeout(timer));
}
