import { useState } from "react";
import { Alert } from "react-native";
import { actionKey, attemptBook } from "../data/attempts";
import { useLink } from "./link";

export const owner = { kind: "human", id: "local-owner" } as const;
export const newId = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** Shared by every way of calling the Mac, so a retry from any screen replays its first try. */
export const attempts = attemptBook(() => newId("phone"));

/**
 * Calls a method on the Mac. Failures show as an alert; the screen keeps what was typed. A tap
 * after a timeout replays the same command (see attempts.ts); pass `key` when the params carry
 * values that change on every tap, such as a timestamp.
 */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const run = async (
    method: string,
    params: unknown,
    options: { key?: string; quiet?: boolean } = {},
  ): Promise<unknown> => {
    const client = useLink.getState().client;
    if (!client || busy) return undefined;
    setBusy(true);
    try {
      return await attempts.run(options.key ?? actionKey(method, params), params, (sent, id) =>
        client.getState().call(method, sent, id),
      );
    } catch (error) {
      if (options.quiet) throw error;
      Alert.alert(
        "That did not go through",
        error instanceof Error ? error.message : String(error),
      );
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  return { run, busy };
}

export const answer = (
  action: "accept" | "decline" | "cancel",
  extra: Record<string, unknown> = {},
) => ({
  action,
  ...extra,
  by: owner,
  at: new Date().toISOString(),
});
