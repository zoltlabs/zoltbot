import { useRef, useState } from "react";
import type { ChatConnection } from "../chat/types.js";
export type CompareRun = (
  method: string,
  params: Record<string, unknown>,
  receiptKey?: string,
) => Promise<boolean>;
/** Keep uncertain command identities; a review batch also retains confirmed receipts for partial retries. */
export function useCompareActions(connection: ChatConnection) {
  const attempts = useRef(new Map<string, string>());
  const [pending, setPending] = useState(0),
    [error, setError] = useState("");
  const run: CompareRun = async (method, params, receiptKey) => {
    const signature = JSON.stringify({ method, params, receiptKey });
    let id = attempts.current.get(signature);
    if (!id) {
      id = crypto.randomUUID();
      attempts.current.set(signature, id);
    }
    setPending((n) => n + 1);
    setError("");
    try {
      await connection.call(method, params, id);
      if (!receiptKey) attempts.current.delete(signature);
      return true;
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : "";
      setError(
        code.includes("compare_answers_changed")
          ? "Answers changed. Refresh the preview before running differences."
          : code.includes("compare_read_only_unavailable")
            ? "This profile cannot run read-only. Choose another profile."
            : "This action could not be confirmed. Your draft is still here; reconnect and retry.",
      );
      return false;
    } finally {
      setPending((n) => n - 1);
    }
  };
  return { run, busy: pending > 0, error };
}
