import { parse, type UserInput, UserInputSchema } from "@zoltbot/protocol";

export interface InjectionFragment {
  id: string;
  kind: "peer" | "context_pack" | "brief" | "reminder" | "late_answer" | "status";
  text: string;
  reference: string;
  priority?: number;
}
export function enforceInjectionBudget(options: {
  human: UserInput;
  fragments: readonly InjectionFragment[];
  firstTurn?: boolean;
  fixedInjectedTokens?: number;
  hardCap?: number;
  averageTarget?: number;
  refreshAllowed?: boolean;
  estimate: (text: string) => number;
}) {
  parse(UserInputSchema, options.human);
  const cap = options.hardCap ?? (options.firstTurn ? 4000 : 1500);
  const average = options.averageTarget ?? Math.min(cap, options.firstTurn ? 1500 : 400);
  const fixed = options.fixedInjectedTokens ?? 0;
  if (
    !Number.isSafeInteger(cap) ||
    cap < 1 ||
    cap > 1000000 ||
    !Number.isSafeInteger(average) ||
    average < 0 ||
    average > cap ||
    !Number.isSafeInteger(fixed) ||
    fixed < 0
  )
    throw new Error("invalid_injection_budget");
  if (fixed > cap) throw new Error("injection_fixed_budget_exceeded");
  if (
    options.fragments.length > 100 ||
    new Set(options.fragments.map((fragment) => fragment.id)).size !== options.fragments.length
  )
    throw new Error("invalid_injection_fragments");
  const estimate = (text: string) => {
    const count = options.estimate(text);
    if (!Number.isSafeInteger(count) || count < 0) throw new Error("invalid_token_estimate");
    return count;
  };
  estimate("");
  let generatedCharacters = 0;
  const fragments = options.fragments.map((fragment) => {
    if (
      !/^[a-zA-Z0-9._:-]{1,200}$/.test(fragment.id) ||
      !["peer", "context_pack", "brief", "reminder", "late_answer", "status"].includes(
        fragment.kind,
      ) ||
      !fragment.reference ||
      fragment.reference.length > 512 ||
      [...fragment.reference].some((char) => char.charCodeAt(0) < 32) ||
      (fragment.priority !== undefined && !Number.isSafeInteger(fragment.priority))
    )
      throw new Error("invalid_injection_fragment");
    generatedCharacters += fragment.text.length;
    if (generatedCharacters > 1000000) throw new Error("injection_fragments_too_large");
    if (fragment.kind === "reminder" && !options.refreshAllowed)
      throw new Error("undeclared_reminder");
    const header = `[${fragment.kind}:${fragment.id}]`;
    return {
      ...fragment,
      full: `${header}\n${fragment.text}`,
      short: `${header} More: ${fragment.reference}`,
      shortened: fragment.kind === "peer" && [...fragment.text].length > 2000,
    };
  });
  const body = (fragment: (typeof fragments)[number]) =>
    fragment.shortened ? fragment.short : fragment.full;
  const render = () =>
    fragments.length ? `\n\n[Zoltbot context]\n${fragments.map(body).join("\n\n")}` : "";
  const packCost = () =>
    estimate(
      fragments
        .filter((fragment) => fragment.kind === "context_pack")
        .map(body)
        .join("\n\n"),
    );
  const ordered = [...fragments].sort(
    (a, b) =>
      Number(b.kind === "context_pack") - Number(a.kind === "context_pack") ||
      (a.priority ?? 0) - (b.priority ?? 0) ||
      a.id.localeCompare(b.id),
  );
  const packCap = Math.min(1500, cap);
  for (const fragment of ordered) {
    if (packCost() <= packCap && fixed + estimate(render()) <= cap) break;
    if (fragment.shortened || (packCost() > packCap && fragment.kind !== "context_pack")) continue;
    if (estimate(fragment.short) < estimate(fragment.full)) fragment.shortened = true;
  }
  const injectedText = render();
  const estimatedTokens = fixed + estimate(injectedText);
  if (estimatedTokens > cap || packCost() > packCap) throw new Error("injection_budget_exceeded");
  const input: UserInput = structuredClone(options.human);
  if (injectedText) input.push({ type: "text", text: injectedText });
  return {
    input,
    injectedText,
    estimatedTokens,
    aboveAverage: estimatedTokens > average,
    shortened: fragments.filter((fragment) => fragment.shortened).map((fragment) => fragment.id),
  };
}
