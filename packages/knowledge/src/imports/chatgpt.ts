// M4: ChatGPT's data export (a ZIP with conversations.json, and memories when the export has them).

import { savedMemories } from "./memories.js";
import {
  type ExportFiles,
  findFile,
  type ImportedConversation,
  type ImportedExport,
  isoTime,
  json,
  keepConversations,
  keepMemories,
  rows,
  str,
} from "./types.js";

type Row = Record<string, unknown>;

function textOf(message: Row): string {
  const content = (message.content ?? {}) as Row;
  const parts = Array.isArray(content.parts) ? content.parts : [];
  const text = parts.filter((part): part is string => typeof part === "string").join("\n");
  return text || str(content.text);
}

/** The branch the owner last saw: from the current node back to the root. */
function turnsOf(conversation: Row): ImportedConversation["turns"] {
  const mapping = (conversation.mapping ?? {}) as Record<string, Row>;
  const turns: ImportedConversation["turns"] = [];
  const seen = new Set<string>();
  let id = str(conversation.current_node);
  while (id && mapping[id] && !seen.has(id)) {
    seen.add(id);
    const node = mapping[id] as Row;
    const message = node.message as Row | undefined;
    const role = str((message?.author as Row | undefined)?.role);
    if (message && (role === "user" || role === "assistant")) {
      const text = textOf(message);
      if (text.trim()) turns.push({ role, text });
    }
    id = str(node.parent);
  }
  return turns.reverse();
}

export function parseChatGpt(files: ExportFiles): ImportedExport {
  const conversations = rows(json(findFile(files, "conversations.json"))).map((row) => ({
    title: str(row.title),
    at: isoTime(row.update_time ?? row.create_time),
    turns: turnsOf(row),
  }));
  return {
    source: "chatgpt",
    memories: keepMemories(savedMemories(json(findFile(files, "memories.json", "memory.json")))),
    conversations: keepConversations(conversations),
  };
}
