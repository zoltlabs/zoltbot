import { OutcomeUnknownError } from "./transport.js";

/**
 * Command ids for user actions. An action whose outcome is unknown (timeout, dropped link) keeps
 * its id and params, so tapping again replays the same command and the Mac answers from its
 * receipt instead of running it twice. A definite answer, success or refusal, forgets it.
 */
export function attemptBook(newId: () => string) {
  const open = new Map<string, { commandId: string; params: unknown }>();
  return {
    async run<T>(
      key: string,
      params: unknown,
      send: (params: unknown, commandId: string) => Promise<T>,
    ): Promise<T> {
      const attempt = open.get(key) ?? { commandId: newId(), params };
      open.set(key, attempt);
      try {
        const result = await send(attempt.params, attempt.commandId);
        open.delete(key);
        return result;
      } catch (error) {
        if (!(error instanceof OutcomeUnknownError)) open.delete(key);
        throw error;
      }
    },
    pending(key: string) {
      return open.has(key);
    },
  };
}

/** The default key: same method and same params is the same action. */
export function actionKey(method: string, params: unknown) {
  return `${method}:${stableJson(params)}`;
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
