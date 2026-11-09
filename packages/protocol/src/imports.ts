import { type Static, Type } from "@sinclair/typebox";
import { Id, Json, OptionalText, object, Text, values } from "./common.js";
export const ImportItemSchema = object({
  id: Id,
  kind: values(["project", "session", "mcp"]),
  source: Id,
  name: Text,
  path: OptionalText,
  repoRoot: OptionalText,
  scopePath: OptionalText,
  nativePath: OptionalText,
  nativeId: OptionalText,
  modifiedAt: Type.Optional(Type.Number({ minimum: 0 })),
  /** GitHub owner/name read from the repository's origin remote. */
  remote: OptionalText,
  /** A session file small enough to be an abandoned start, judged from its size alone. */
  brief: Type.Optional(Type.Boolean()),
  configuration: Type.Optional(Type.Record(Text, Json)),
});
export type ImportItem = Static<typeof ImportItemSchema>;
export const ImportReceiptSchema = object({ id: Id, items: Type.Array(ImportItemSchema) });
export type ImportReceipt = Static<typeof ImportReceiptSchema>;

export const importSourceOptions = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "cursor", label: "Cursor" },
  { id: "grok", label: "Grok" },
  { id: "pi", label: "Pi" },
  { id: "gemini", label: "Gemini" },
  { id: "opencode", label: "OpenCode" },
  { id: "cline", label: "Cline" },
] as const;
