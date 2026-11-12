import { type Row, text } from "../types.js";
import { outputText } from "./tool-data.js";

export function webResultUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || /\s/.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
      return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}
const record = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};

/** Explicit MCP resource links and structured search results; log text never becomes navigation. */
export function resultLinks(value: Row): { url: string; label: string; description: string }[] {
  const output = record(value.output);
  const structured = record(output.structuredContent ?? value.structuredContent);
  const content = [value.content, output.content].flatMap((part) =>
    Array.isArray(part) ? part : [],
  );
  const candidates = [
    ...content.filter((part) => record(part).type === "resource_link"),
    ...(Array.isArray(structured.results) ? structured.results : []),
    ...(Array.isArray(structured.items) ? structured.items : []),
  ];
  const links = new Map<string, { url: string; label: string; description: string }>();
  for (const candidate of candidates) {
    const row = record(candidate);
    const url = webResultUrl(row.uri ?? row.url);
    if (!url) continue;
    links.set(url, {
      url,
      label: text(row.title) || text(row.name) || text(row.label) || new URL(url).hostname,
      description: text(row.description),
    });
  }
  return [...links.values()];
}

export function executionResult(value: Row) {
  const output = record(value.output);
  const code = output.exitCode ?? value.exitCode;
  return {
    output: outputText(value.output ?? value.content),
    exitCode: typeof code === "number" && Number.isSafeInteger(code) ? code : undefined,
  };
}
