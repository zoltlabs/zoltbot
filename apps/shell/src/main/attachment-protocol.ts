// C16: serves openbot-attachment:// for previews. Files stream from disk with byte ranges, so
// video can seek and large files never sit in memory. Markdown is rendered here, sanitized, and
// shown in a scriptless frame. Every response but a PDF's carries its own strict policy.
import { constants, createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { Readable } from "node:stream";
import type { AttachmentSource } from "../zolt/sent-attachments";
import { artifactMarkdownHtml } from "./desktop/artifact-markdown";

export const ATTACHMENT_SCHEME = "openbot-attachment";
const MARKDOWN_BYTES = 2 * 1024 * 1024;
/** No scripts, no network, no plugins; a document response is also sandboxed. */
export const ATTACHMENT_POLICY =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; media-src 'self'; sandbox";

const notFound = () => new Response("Not found", { status: 404 });
// Non-blocking, so a named pipe or device never stalls main's file threads.
const READ_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK;

/** The attachment id in a request URL, or undefined. */
export function attachmentId(url: string): string | undefined {
  try {
    const segment = new URL(url).pathname.split("/").filter(Boolean).at(-1);
    return segment ? decodeURIComponent(segment) : undefined;
  } catch {
    return undefined;
  }
}

function headers(mimeType: string, extra: Record<string, string> = {}): Headers {
  const result = new Headers({
    // Text kinds are always plain text here, so an .html attachment never renders as a page.
    "Content-Type": mimeType.startsWith("text/") ? `${mimeType}; charset=utf-8` : mimeType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": "inline",
    ...extra,
  });
  if (mimeType !== "application/pdf") result.set("Content-Security-Policy", ATTACHMENT_POLICY);
  return result;
}

/** "bytes=a-b", "bytes=a-" or "bytes=-n" against a size; undefined for none, many or unreadable. */
export function byteRange(
  header: string | null,
  size: number,
): { start: number; end: number } | "invalid" | undefined {
  const match = header?.trim().match(/^bytes=(\d*)-(\d*)$/);
  // Several ranges or an odd header get the whole file, as HTTP allows.
  if (!match) return undefined;
  if (!match[1] && !match[2]) return "invalid";
  let start: number;
  let end: number;
  if (!match[1]) {
    start = Math.max(0, size - Number(match[2]));
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  }
  return start > end || start >= size ? "invalid" : { start, end };
}

async function markdown(path: string): Promise<Response> {
  const handle = await open(path, READ_FLAGS);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return notFound();
    const { size } = stat;
    const bytes = Buffer.alloc(Math.min(size, MARKDOWN_BYTES));
    await handle.read(bytes, 0, bytes.length, 0);
    return new Response(artifactMarkdownHtml(bytes.toString("utf8")), {
      headers: headers("text/html"),
    });
  } finally {
    await handle.close();
  }
}

export async function attachmentResponse(
  request: Request,
  source: AttachmentSource | undefined,
): Promise<Response> {
  if (!source) return notFound();
  if ("bytes" in source) {
    return new Response(Buffer.from(source.bytes), {
      headers: headers(source.mimeType, { "Content-Length": String(source.bytes.byteLength) }),
    });
  }
  try {
    const view = new URL(request.url).searchParams.get("view");
    if (view === "markdown" && source.mimeType === "text/markdown")
      return await markdown(source.path);
    const handle = await open(source.path, READ_FLAGS);
    let size: number;
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return notFound();
      size = stat.size;
    } finally {
      await handle.close();
    }
    const range = byteRange(request.headers.get("Range"), size);
    if (range === "invalid") {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    }
    const { start, end } = range ?? { start: 0, end: size - 1 };
    const body =
      size === 0
        ? null
        : (Readable.toWeb(createReadStream(source.path, { start, end })) as ReadableStream);
    return new Response(body, {
      status: range ? 206 : 200,
      headers: headers(source.mimeType, {
        "Accept-Ranges": "bytes",
        "Content-Length": String(size === 0 ? 0 : end - start + 1),
        ...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
      }),
    });
  } catch {
    return notFound();
  }
}
