import type { Interaction } from "@zoltbot/protocol";
import { useRef, useState } from "react";
import { type AnswerDraft, answerError, singleFlight } from "../../data/interactions";
import { attempts, owner } from "../../state/actions";
import { useClient, useLink } from "../../state/link";

/**
 * Sends one answer for a pending interaction. Errors stay on the card (no alert) so a stale
 * version or a dropped link never loses what was typed; the card disappears when the
 * interaction stops being pending.
 */
export function useAnswer(request: Interaction) {
  const online = useClient((state) => state.status === "online");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Guards double taps synchronously; `busy` only drives the UI.
  const flight = useRef(singleFlight());
  const submit = async (draft: AnswerDraft): Promise<boolean> => {
    if (request.state !== "pending") return false;
    if (useLink.getState().client?.getState().status !== "online") {
      setError("Reconnect to your Mac, then send your answer again.");
      return false;
    }
    const client = useLink.getState().client;
    if (!client) {
      setError(answerError(new Error("Not connected to your Mac.")));
      return false;
    }
    if (!flight.current.enter()) return false;
    setBusy(true);
    setError("");
    try {
      // A retry after a lost reply resends the first answer with its command id (attempts.ts).
      await attempts.run(
        `answer:${request.id}:${request.version}`,
        {
          id: request.id,
          version: request.version,
          answer: { ...draft, by: owner, at: new Date().toISOString() },
        },
        (params, commandId) => client.getState().call("interaction.answer", params, commandId),
      );
      return true;
    } catch (cause) {
      setError(answerError(cause));
      return false;
    } finally {
      flight.current.leave();
      setBusy(false);
    }
  };
  return { submit, busy, error, disabled: busy || !online, online };
}
