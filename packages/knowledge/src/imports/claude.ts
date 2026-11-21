// M4: Claude's data export (conversations.json, projects.json, and memories when present).
import { savedMemories } from "./memories.js";
import {
  type ExportFiles,
  findFile,
  type ImportedExport,
  type ImportedMemory,
  isoTime,
  json,
  keepConversations,
  keepMemories,
  rows,
  str,
} from "./types.js";

type Row = Record<string, unknown>;

function messageText(message: Row): string {
  const text = str(message.text);
  if (text) return text;
  return rows(message.content)
    .filter((part) => part.type === "text")
    .map((part) => str(part.text))
    .join("\n");
}

/** A project's description and instructions become a memory to review; its files are not read. */
function projectMemories(projects: unknown): ImportedMemory[] {
  return rows(projects).flatMap((project) => {
    const about = [str(project.description), str(project.prompt_template)].filter(Boolean);
    return about.length
      ? [{ title: str(project.name) || "Project", body: about.join("\n\n") }]
      : [];
  });
}

export function parseClaude(files: ExportFiles): ImportedExport {
  const conversations = rows(json(findFile(files, "conversations.json"))).map((row) => ({
    title: str(row.name),
    at: isoTime(row.updated_at ?? row.created_at),
    turns: rows(row.chat_messages).flatMap((message) => {
      const role =
        message.sender === "human"
          ? "user"
          : message.sender === "assistant"
            ? "assistant"
            : undefined;
      return role ? [{ role, text: messageText(message) } as const] : [];
    }),
  }));
  return {
    source: "claude",
    memories: keepMemories([
      ...savedMemories(json(findFile(files, "memories.json"))),
      ...projectMemories(json(findFile(files, "projects.json"))),
    ]),
    conversations: keepConversations(conversations),
  };
}
