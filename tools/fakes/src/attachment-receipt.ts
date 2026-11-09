import { renameSync, writeFileSync } from "node:fs";
import path from "node:path";
/** Synthetic provider witness. Never stores image bytes or absolute file references. */
export function recordAttachments(texts: string[], images: { data?: string; mimeType?: string }[]) {
  if (!images.length) return;
  const receipt = path.join(process.cwd(), "attachment-receipt.json");
  const temporary = `${receipt}.${process.pid}.tmp`;
  writeFileSync(
    temporary,
    JSON.stringify({
      images: images.length,
      png: images.every(
        (image) =>
          image.mimeType === "image/png" &&
          Buffer.from(image.data ?? "", "base64")
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
      ),
      textPreserved: texts.some((text) => text.startsWith("  Exact text\n")),
      fileReference: texts.some((text) => text.startsWith("@") || text.includes("\n@")),
    }),
  );
  renameSync(temporary, receipt);
}
