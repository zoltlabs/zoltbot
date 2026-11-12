import type { InteractionAnswer } from "./interactions.js";

type PrivateFields = { items: readonly { id: string; secret?: boolean }[] };
function scalars(value: unknown): string[] {
  const pending = [value],
    result: string[] = [];
  let visited = 0;
  while (pending.length) {
    if (++visited > 10000) throw new Error("private_value_too_large");
    const entry = pending.pop();
    if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") {
      const text = String(entry);
      if (text) result.push(text);
    } else if (entry && typeof entry === "object") pending.push(...Object.values(entry));
  }
  return result;
}
export function privateAnswerValues(
  request: PrivateFields,
  answer: InteractionAnswer,
): Set<string> {
  return new Set(
    request.items
      .filter((item) => item.secret)
      .flatMap((item) => scalars(answer.answers?.[item.id])),
  );
}
export function publicAnswerData(request: PrivateFields, answer: InteractionAnswer): unknown[] {
  const privateIds = new Set(request.items.filter((item) => item.secret).map((item) => item.id));
  return [
    answer.feedback,
    answer.device,
    answer.signedApproval,
    ...Object.entries(answer.answers ?? {})
      .filter(([id]) => !privateIds.has(id))
      .flatMap(([, value]) => [value.other, value.value]),
  ].filter((value) => value !== undefined);
}
/** Reject before persistence. Do not silently rewrite an exact human draft. */
export function assertNoPrivateValue(value: unknown, known: Iterable<string>): void {
  const privateValues = [...known].filter(Boolean);
  if (!privateValues.length) return;
  for (const text of scalars(value))
    if (privateValues.some((secret) => text.includes(secret)))
      throw new Error("private_value_requires_secure_field");
}
