// A small ICU MessageFormat subset: {name}, {count, number}, {count, plural, …}
// with # and =N cases, and {value, select, …}. Plurals use Intl.PluralRules.
// apps/mobile/src/i18n/format.ts is an exact copy; a test keeps them equal.

export type MessageParams = Readonly<Record<string, string | number>>;

type Part =
  | { type: "text"; value: string }
  | { type: "arg"; name: string; format?: "number" }
  | { type: "plural"; name: string; cases: Record<string, Part[]> }
  | { type: "select"; name: string; cases: Record<string, Part[]> }
  | { type: "pound" };

export function parseMessage(source: string): Part[] {
  const parser = { source, index: 0 };
  const parts = parseParts(parser, false);
  if (parser.index < source.length) throw new Error(`Unexpected "}" in message: ${source}`);
  return parts;
}

/** Names of every argument a message uses, for placeholder checks between catalogs. */
export function messageArguments(source: string): string[] {
  const names = new Set<string>();
  const visit = (parts: Part[]) => {
    for (const part of parts) {
      if (part.type === "arg" || part.type === "plural" || part.type === "select")
        names.add(part.name);
      if (part.type === "plural" || part.type === "select")
        for (const nested of Object.values(part.cases)) visit(nested);
    }
  };
  visit(parseMessage(source));
  return [...names].sort();
}

export function formatMessage(source: string, params: MessageParams, locale: string): string {
  return render(parseMessage(source), params, locale, undefined);
}

function render(
  parts: Part[],
  params: MessageParams,
  locale: string,
  count: number | undefined,
): string {
  let out = "";
  for (const part of parts) {
    switch (part.type) {
      case "text":
        out += part.value;
        break;
      case "pound":
        out += count === undefined ? "#" : new Intl.NumberFormat(locale).format(count);
        break;
      case "arg": {
        const value = requireParam(params, part.name);
        out +=
          part.format === "number" || typeof value === "number"
            ? new Intl.NumberFormat(locale).format(Number(value))
            : value;
        break;
      }
      case "plural": {
        const value = Number(requireParam(params, part.name));
        const exact = part.cases[`=${value}`];
        const category = new Intl.PluralRules(locale).select(value);
        const chosen = exact ?? part.cases[category] ?? part.cases.other;
        out += render(chosen ?? [], params, locale, value);
        break;
      }
      case "select": {
        const value = String(requireParam(params, part.name));
        out += render(part.cases[value] ?? part.cases.other ?? [], params, locale, count);
        break;
      }
    }
  }
  return out;
}

function requireParam(params: MessageParams, name: string): string | number {
  const value = params[name];
  if (value === undefined) throw new Error(`Missing message parameter: ${name}`);
  return value;
}

interface Parser {
  source: string;
  index: number;
}

function parseParts(parser: Parser, inPlural: boolean): Part[] {
  const parts: Part[] = [];
  let text = "";
  const flush = () => {
    if (text) parts.push({ type: "text", value: text });
    text = "";
  };
  while (parser.index < parser.source.length) {
    const char = parser.source[parser.index];
    if (char === "}") break;
    if (char === "'" && parser.source[parser.index + 1] === "'") {
      text += "'";
      parser.index += 2;
    } else if (char === "'" && /[{}#]/.test(parser.source[parser.index + 1] ?? "")) {
      const end = parser.source.indexOf("'", parser.index + 1);
      if (end < 0) throw new Error(`Unclosed quote in message: ${parser.source}`);
      text += parser.source.slice(parser.index + 1, end);
      parser.index = end + 1;
    } else if (char === "#" && inPlural) {
      flush();
      parts.push({ type: "pound" });
      parser.index++;
    } else if (char === "{") {
      flush();
      parser.index++;
      parts.push(parseArgument(parser));
    } else {
      text += char;
      parser.index++;
    }
  }
  flush();
  return parts;
}

function parseArgument(parser: Parser): Part {
  const name = readToken(parser);
  if (!name) throw new Error(`Empty argument in message: ${parser.source}`);
  skipSpace(parser);
  if (take(parser, "}")) return { type: "arg", name };
  expect(parser, ",");
  const kind = readToken(parser);
  skipSpace(parser);
  if (kind === "number") {
    expect(parser, "}");
    return { type: "arg", name, format: "number" };
  }
  if (kind !== "plural" && kind !== "select")
    throw new Error(`Unsupported argument type "${kind}" in message: ${parser.source}`);
  expect(parser, ",");
  const cases: Record<string, Part[]> = {};
  for (;;) {
    skipSpace(parser);
    if (take(parser, "}")) break;
    const key = readToken(parser);
    if (!key) throw new Error(`Expected a case name in message: ${parser.source}`);
    skipSpace(parser);
    expect(parser, "{");
    cases[key] = parseParts(parser, kind === "plural");
    expect(parser, "}");
  }
  if (!cases.other) throw new Error(`"${name}" needs an "other" case in message: ${parser.source}`);
  return { type: kind, name, cases };
}

function readToken(parser: Parser): string {
  skipSpace(parser);
  const match = /^[=\w.-]+/.exec(parser.source.slice(parser.index));
  if (!match) return "";
  parser.index += match[0].length;
  return match[0];
}

function skipSpace(parser: Parser): void {
  while (/\s/.test(parser.source[parser.index] ?? "")) parser.index++;
}

function take(parser: Parser, char: string): boolean {
  if (parser.source[parser.index] !== char) return false;
  parser.index++;
  return true;
}

function expect(parser: Parser, char: string): void {
  skipSpace(parser);
  if (!take(parser, char))
    throw new Error(`Expected "${char}" at ${parser.index} in message: ${parser.source}`);
}
