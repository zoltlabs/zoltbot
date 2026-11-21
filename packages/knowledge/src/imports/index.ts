import { parseChatGpt } from "./chatgpt.js";
import { parseClaude } from "./claude.js";
import { parseGemini } from "./gemini.js";
import type { ExportFiles, ImportedExport, ImportSource } from "./types.js";

export { savedMemories } from "./memories.js";
export * from "./propose.js";
export * from "./types.js";
export { parseChatGpt, parseClaude, parseGemini };

const parsers: Record<ImportSource, (files: ExportFiles) => ImportedExport> = {
  chatgpt: parseChatGpt,
  claude: parseClaude,
  gemini: parseGemini,
};

/** The files each export needs; nothing else in the ZIP is read. */
export const exportFiles: Record<ImportSource, RegExp> = {
  chatgpt: /(?:^|\/)(?:conversations|memories|memory)\.json$/i,
  claude: /(?:^|\/)(?:conversations|memories|projects)\.json$/i,
  gemini: /gemini[^/]*\/myactivity\.json$|^myactivity\.json$/i,
};

export function parseExport(source: ImportSource, files: ExportFiles): ImportedExport {
  return parsers[source](files);
}

/** The conversations as plain text for the extraction task to read, newest first. */
export function conversationsText(parsed: ImportedExport): string {
  return parsed.conversations
    .map((conversation) =>
      [
        `## ${conversation.title}${conversation.at ? ` (${conversation.at.slice(0, 10)})` : ""}`,
        ...conversation.turns.map(
          (turn) => `${turn.role === "user" ? "Owner" : "Assistant"}: ${turn.text}`,
        ),
      ].join("\n\n"),
    )
    .join("\n\n---\n\n");
}
