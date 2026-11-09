import { requestJson } from "./network.js";
import type { GoogleServiceId } from "./service-catalog.js";

type Json = Record<string, unknown>;
type Arguments = {
  query?: string;
  pageToken?: string;
  limit?: number;
  offset?: number;
  messageId?: string;
  threadId?: string;
  fileId?: string;
  documentId?: string;
};
interface MessagePart {
  mimeType?: string;
  filename?: string;
  body?: { data?: string };
  parts?: MessagePart[];
  headers?: { name: string; value: string }[];
}

const string = { type: "string", maxLength: 1000 };
const id = { type: "string", pattern: "^[a-zA-Z0-9_-]{1,200}$" };
const paging = { pageToken: string, limit: { type: "integer", minimum: 1, maximum: 10 } };
const offset = { type: "integer", minimum: 0, maximum: 1000000 };
const tool = (
  name: string,
  description: string,
  properties: Record<string, object>,
  required: string[] = [],
) => ({
  name,
  description,
  inputSchema: { type: "object" as const, properties, required, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
});
export function googleTools(service: GoogleServiceId) {
  if (service === "gmail")
    return [
      tool(
        "gmail_search",
        "Search authorized Gmail messages. Returns IDs for gmail_read_message.",
        { query: string, ...paging },
      ),
      tool(
        "gmail_read_thread",
        "Read a bounded page of thread text; attachments are omitted.",
        { threadId: id, offset },
        ["threadId"],
      ),
      tool(
        "gmail_read_message",
        "Read message headers and a bounded page of message text; attachments are omitted.",
        { messageId: id, offset },
        ["messageId"],
      ),
    ];
  return [
    tool(
      "drive_search",
      "Search authorized Drive files using Drive query syntax. Docs connections return only Google Docs.",
      { query: string, ...paging },
    ),
    ...(service === "google_drive"
      ? [
          tool(
            "drive_read_file",
            "Read a Google Doc export or UTF-8 text/JSON file. Binary files return metadata only. Results are paged.",
            { fileId: id, offset },
            ["fileId"],
          ),
        ]
      : [
          tool(
            "docs_read_document",
            "Read Google Docs text, including tables and tabs, in bounded pages.",
            { documentId: id, offset },
            ["documentId"],
          ),
        ]),
  ];
}
function messageText(root: MessagePart): string {
  const plain: string[] = [],
    html: string[] = [];
  const visit = (part: MessagePart) => {
    if (part.filename) return;
    if (typeof part.body?.data === "string") {
      const value = Buffer.from(part.body.data, "base64url").toString("utf8");
      if (part.mimeType === "text/plain") plain.push(value);
      else if (part.mimeType === "text/html") html.push(value);
    }
    for (const child of part.parts ?? []) visit(child);
  };
  visit(root);
  return plain.length
    ? plain.join("\n")
    : html
        .join("\n")
        .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
        .replace(/<[^>]*>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, "&");
}
function page(text: string, start = 0) {
  const value = text.slice(start, start + 1500);
  return {
    text: value,
    offset: start,
    ...(start + value.length < text.length ? { nextOffset: start + value.length } : {}),
    totalCharacters: text.length,
  };
}
function bounded(value: unknown): unknown {
  if (JSON.stringify(value).length > 3900) throw new Error("google_result_too_large");
  return value;
}
/** Fixed GET-only API surface. No user-supplied origin, path, HTTP method or authorization. */
export async function callGoogleTool(
  service: GoogleServiceId,
  name: string,
  args: Arguments,
  accessToken: string,
  request: typeof requestJson = requestJson,
) {
  if (!googleTools(service).some((t) => t.name === name)) throw new Error("google_tool_denied");
  const get = (url: URL, responseText = false) =>
    request(
      url.href,
      {
        origins: [
          "https://gmail.googleapis.com",
          "https://www.googleapis.com",
          "https://docs.googleapis.com",
        ],
      },
      undefined,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        maxBytes: 2 * 1024 * 1024,
        responseText,
      },
    );
  const identifier = (value: unknown) => {
    if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/.test(value))
      throw new Error("google_identifier_invalid");
    return value;
  };
  if (name === "gmail_search") {
    const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    url.search = new URLSearchParams({
      q: String(args.query ?? ""),
      maxResults: String(args.limit ?? 5),
      ...(args.pageToken ? { pageToken: args.pageToken } : {}),
    }).toString();
    const result = await get(url);
    return bounded({ messages: result.messages ?? [], nextPageToken: result.nextPageToken });
  }
  if (name === "gmail_read_thread") {
    const result = await get(
      new URL(
        `https://gmail.googleapis.com/gmail/v1/users/me/threads/${identifier(args.threadId)}?format=full`,
      ),
    );
    const texts: string[] = [];
    for (const message of (result.messages ?? []) as {
      payload?: MessagePart;
      snippet?: string;
    }[]) {
      const part = message.payload ?? {};
      texts.push(
        (part.headers ?? [])
          .filter((h) => ["from", "subject", "date"].includes(h.name.toLowerCase()))
          .map((h) => `${h.name}: ${h.value.slice(0, 250)}`)
          .join("\n"),
      );
      texts.push(messageText(part) || message.snippet || "");
    }
    return bounded({
      threadId: result.id,
      attachmentsOmitted: true,
      ...page(texts.join("\n"), args.offset),
    });
  }
  if (name === "gmail_read_message") {
    const result = await get(
      new URL(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${identifier(args.messageId)}?format=full`,
      ),
    );
    const headers = ((result.payload as MessagePart | undefined)?.headers ?? [])
      .filter((h: { name: string; value: string }) =>
        ["from", "to", "subject", "date"].includes(String(h.name).toLowerCase()),
      )
      .map((h: { name: string; value: string }) => ({
        name: h.name,
        value: String(h.value).slice(0, 250),
      }));
    return bounded({
      id: result.id,
      headers,
      attachmentsOmitted: true,
      ...page(
        messageText((result.payload ?? {}) as MessagePart) || String(result.snippet ?? ""),
        args.offset,
      ),
    });
  }
  if (name === "drive_search") {
    const url = new URL("https://www.googleapis.com/drive/v3/files");
    const query = [
      "trashed = false",
      ...(service === "google_docs" ? ["mimeType = 'application/vnd.google-apps.document'"] : []),
      ...(args.query ? [`(${args.query})`] : []),
    ].join(" and ");
    url.search = new URLSearchParams({
      q: query,
      pageSize: String(args.limit ?? 5),
      fields: "nextPageToken,files(id,name,mimeType,webViewLink)",
      ...(args.pageToken ? { pageToken: args.pageToken } : {}),
    }).toString();
    return bounded(await get(url));
  }
  if (name === "drive_read_file") {
    const fileId = identifier(args.fileId);
    const url = `https://www.googleapis.com/drive/v3/files/${fileId}`;
    const metadata = await get(new URL(`${url}?fields=id,name,mimeType,size`));
    const mime = String(metadata.mimeType);
    let text: string;
    if (mime === "application/vnd.google-apps.document") {
      text = String((await get(new URL(`${url}/export?mimeType=text%2Fplain`), true)).text);
    } else if (mime.startsWith("text/") || mime === "application/json") {
      text = String((await get(new URL(`${url}?alt=media`), true)).text);
    } else return bounded({ ...metadata, contentUnavailable: "binary_file_not_supported" });
    return bounded({
      id: metadata.id,
      name: String(metadata.name).slice(0, 250),
      ...page(text, args.offset),
    });
  }
  const result = await get(
    new URL(
      `https://docs.googleapis.com/v1/documents/${identifier(args.documentId)}?includeTabsContent=true`,
    ),
  );
  const texts: string[] = [];
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const row = value as Json;
    const run = row.textRun as { content?: unknown } | undefined;
    if (typeof run?.content === "string") texts.push(run.content);
    for (const [key, child] of Object.entries(row)) {
      if (key === "textRun") continue;
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === "object") visit(child);
    }
  };
  visit(result.tabs ?? result.body);
  return bounded({
    documentId: result.documentId,
    title: String(result.title).slice(0, 250),
    ...page(texts.join(""), args.offset),
  });
}
