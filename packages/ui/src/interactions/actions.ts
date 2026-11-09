import type { Interaction, InteractionAnswer } from "@zoltbot/protocol";
import { useRef, useState } from "react";
import type { ChatConnection } from "../chat/types.js";

export type AnswerDraft = Omit<InteractionAnswer, "at" | "by">;
export function useInteractionActions(
  connection: ChatConnection,
  request: Interaction,
  deferred?: () => void,
) {
  const [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const attempt = useRef<
    { fingerprint: string; id: string; answer: InteractionAnswer } | undefined
  >(undefined);
  const submit = async (draft: AnswerDraft) => {
    if (pending || request.state !== "pending") return;
    const fingerprint = JSON.stringify([request.id, request.version, draft]);
    if (attempt.current?.fingerprint !== fingerprint)
      attempt.current = {
        fingerprint,
        id: crypto.randomUUID(),
        answer: {
          ...draft,
          by: { kind: "human", id: "local-owner" },
          at: new Date().toISOString(),
        },
      };
    setPending(true);
    setError("");
    try {
      await connection.call(
        "interaction.answer",
        { id: request.id, version: request.version, answer: attempt.current.answer },
        attempt.current.id,
      );
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : "";
      setError(
        code.includes("private_value_requires_secure_field")
          ? "Keep private values in the masked fields. Your draft is preserved."
          : code.includes("runtime_private_context_required")
            ? "Restore protected private context before sending this answer. Your draft is preserved."
            : code.includes("private_context_changed")
              ? "Private context changed. Review your draft and try again."
              : code.includes("conflict") || code.includes("stale")
                ? "This request changed or was answered elsewhere. Review its saved resolution before continuing."
                : code === "secret_storage_unavailable"
                  ? "Protected secret storage is unavailable. Your private value has not been saved."
                  : "Your answer could not be confirmed. Your draft is preserved for review.",
      );
    } finally {
      setPending(false);
    }
  };
  const defer = async () => {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      await connection.call("interaction.defer", { id: request.id }, crypto.randomUUID());
      deferred?.();
    } catch {
      setError("Deferring could not be confirmed. This request remains available.");
    } finally {
      setPending(false);
    }
  };
  return { submit, defer, pending, error };
}
