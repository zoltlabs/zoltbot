import { replyQuote, withQuote } from "@zoltbot/protocol";
import type { DraftAttachment } from "../shared/ipc";
import type { Row } from "./daemon-client";

type Attachment = { path: string; summary: DraftAttachment };

/** The parts of a message to send: a reply's quote and pictures first, then the words and files. */
export function messageParts(
  items: readonly Row[],
  replyToMessageId: string | null | undefined,
  words: string,
  attachments: readonly Attachment[],
): Row[] {
  const quote = replyToMessageId ? replyQuote(items, replyToMessageId) : undefined;
  const text = withQuote(quote?.text ?? "", words);
  const parts: Row[] = [...(quote?.images ?? [])];
  if (text) parts.unshift({ type: "text", text });
  for (const attachment of attachments)
    parts.push(
      attachment.summary.kind === "image"
        ? { type: "image", path: attachment.path, mimeType: attachment.summary.mimeType }
        : { type: "file", path: attachment.path },
    );
  return parts;
}
