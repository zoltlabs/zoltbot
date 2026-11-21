// C16 sample answers: attachment.preview for files picked in sample mode. Sample paths don't
// exist, so the answer is made-up content of the file's kind.
import { fileMimeType, filePreviewKind } from "@zoltbot/protocol";
import type { Row } from "./transport.js";

const SAMPLES: Record<string, string> = {
  csv: "region,units,revenue\nNorth,42,$12,400\nSouth,37,$10,950\nEast,51,$15,300\nWest,29,$8,700\n",
  tsv: "region\tunits\nNorth\t42\nSouth\t37\n",
  markdown: "# Sample notes\n\n- First point\n- Second point\n",
  text: "Sample text file.\n",
};

export function answerAttachmentPreview(items: readonly Row[], p: Row): Row {
  const item = items.find((row) => row.id === p.itemId && row.threadId === p.threadId);
  const body = (item?.body ?? {}) as Row;
  const part = Array.isArray(body.input)
    ? ((body.input as Row[])[Number(p.part)] as Row)
    : undefined;
  if (item?.kind !== "user" || body.origin === "agent" || !part)
    throw new Error("attachment_preview_unavailable");
  if (part.type === "image" && typeof part.base64 === "string") {
    const size = Math.floor((part.base64.length * 3) / 4);
    const mime = typeof part.mimeType === "string" ? part.mimeType : "image/jpeg";
    return {
      kind: "image",
      name: "Photo",
      mime,
      size,
      stamp: "sample",
      data: part.base64,
      next: null,
    };
  }
  const path = typeof part.path === "string" ? part.path : "";
  const kind = filePreviewKind(path);
  const data = SAMPLES[kind];
  if (part.type !== "file" || data === undefined) throw new Error("attachment_preview_unavailable");
  return {
    kind,
    name: path.split("/").pop() ?? "",
    mime: fileMimeType(path),
    size: data.length,
    stamp: "sample",
    data,
    next: null,
  };
}
