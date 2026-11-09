import { methodCatalog, type UserInput } from "@zoltbot/protocol";
import type { Transport } from "./transport.js";

export interface Attachment {
  id: string;
  label: string;
  part: UserInput[number];
}
export interface FileChoice {
  path: string;
  label: string;
}
export const sampleFiles: FileChoice[] = [
  { path: "/Users/you/Projects/example-app/src/meals/search.ts", label: "src/meals/search.ts" },
  { path: "/Users/you/Projects/example-app/README.md", label: "README.md" },
];
export function attachmentAccess(kind: Transport["kind"], threadId?: string) {
  return {
    photo: "turn.send" in methodCatalog,
    file: kind === "fake",
    search: kind === "fake" || Boolean(threadId && "workspace.files" in methodCatalog),
  };
}
export function composeInput(message: string, attachments: Attachment[]): UserInput {
  return [
    ...(message.trim() ? [{ type: "text" as const, text: message.trim() }] : []),
    ...attachments.map((attachment) => attachment.part),
  ];
}
export function searchSampleFiles(query: string, limit = 20) {
  const matches = sampleFiles.filter((file) =>
    file.label.toLowerCase().includes(query.toLowerCase()),
  );
  return { items: matches.slice(0, limit), truncated: matches.length > limit };
}
