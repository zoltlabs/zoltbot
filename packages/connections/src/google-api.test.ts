import { expect, it, vi } from "vitest";
import { callGoogleTool } from "./google-api.js";
import type { requestJson } from "./network.js";

it("decodes and pages Gmail content without attachments or arbitrary endpoints", async () => {
  const request = vi.fn<typeof requestJson>().mockResolvedValue({
    id: "mail",
    payload: {
      mimeType: "multipart/mixed",
      headers: [{ name: "Subject", value: "Demo" }],
      parts: [
        {
          mimeType: "text/plain",
          body: { data: Buffer.from("a".repeat(3000)).toString("base64url") },
        },
        { mimeType: "application/pdf", body: { data: "PRIVATE_ATTACHMENT" } },
      ],
    },
  });
  const first = await callGoogleTool(
    "gmail",
    "gmail_read_message",
    { messageId: "mail" },
    "secret",
    request,
  );
  expect(first).toMatchObject({
    attachmentsOmitted: true,
    nextOffset: 1500,
    text: "a".repeat(1500),
  });
  expect(JSON.stringify(first)).not.toContain("PRIVATE_ATTACHMENT");
  await expect(
    callGoogleTool(
      "gmail",
      "gmail_read_message",
      { messageId: "https://evil.example" },
      "secret",
      request,
    ),
  ).rejects.toThrow("identifier");
  await expect(
    callGoogleTool("gmail", "docs_read_document", { documentId: "doc" }, "secret", request),
  ).rejects.toThrow("denied");
  expect(request).toHaveBeenCalledTimes(1);
});
it("uses stable Docs tabs/table content and keeps Drive file reads GET-only", async () => {
  const docs = vi.fn<typeof requestJson>().mockResolvedValue({
    documentId: "doc",
    title: "Demo",
    tabs: [
      {
        documentTab: {
          body: {
            content: [
              { paragraph: { elements: [{ textRun: { content: "Heading\n" } }] } },
              {
                table: {
                  tableRows: [
                    {
                      tableCells: [
                        {
                          content: [
                            { paragraph: { elements: [{ textRun: { content: "Cell\n" } }] } },
                          ],
                        },
                      ],
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    ],
  });
  expect(
    await callGoogleTool(
      "google_docs",
      "docs_read_document",
      { documentId: "doc" },
      "secret",
      docs,
    ),
  ).toMatchObject({ text: "Heading\nCell\n" });
  const drive = vi
    .fn<typeof requestJson>()
    .mockResolvedValueOnce({ id: "file", name: "Data", mimeType: "text/plain" })
    .mockResolvedValueOnce({ text: "fixture" });
  expect(
    await callGoogleTool("google_drive", "drive_read_file", { fileId: "file" }, "secret", drive),
  ).toMatchObject({ text: "fixture" });
  for (const [url, , body] of drive.mock.calls) {
    expect(new URL(url).origin).toBe("https://www.googleapis.com");
    expect(body).toBeUndefined();
  }
  const binary = vi
    .fn<typeof requestJson>()
    .mockResolvedValue({ id: "pdf", mimeType: "application/pdf" });
  expect(
    await callGoogleTool("google_drive", "drive_read_file", { fileId: "pdf" }, "secret", binary),
  ).toMatchObject({ contentUnavailable: "binary_file_not_supported" });
  expect(binary).toHaveBeenCalledTimes(1);
});

it("rejects old preview resources before reading credentials", async () => {
  const { resolveConnections } = await import("./materialize.js");
  const read = vi.fn();
  await expect(
    resolveConnections(
      [
        {
          id: "legacy",
          version: 1,
          name: "gmail",
          projectId: "project",
          transport: { kind: "https", url: "https://gmailmcp.googleapis.com/mcp/v1" },
          schemaTokens: { value: 512, source: "estimated" },
        },
      ],
      { read },
      () => {},
      () => {},
    ),
  ).rejects.toThrow("google_reconnect_required");
  expect(read).not.toHaveBeenCalled();
});
it("reads HTML-only messages as inert text and omits named text attachments", async () => {
  const get = vi.fn<typeof requestJson>().mockResolvedValue({
    id: "mail",
    payload: {
      parts: [
        {
          mimeType: "text/html",
          body: {
            data: Buffer.from(
              "<h1>Demo</h1><script>PRIVATE_SCRIPT</script><p>Safe &amp; readable</p>",
            ).toString("base64url"),
          },
        },
        {
          mimeType: "text/plain",
          filename: "secret.txt",
          body: { data: Buffer.from("PRIVATE_ATTACHMENT_TEXT").toString("base64url") },
        },
      ],
    },
  });
  const read = await callGoogleTool(
    "gmail",
    "gmail_read_message",
    { messageId: "mail" },
    "token",
    get,
  );
  expect(JSON.stringify(read)).toContain("Safe & readable");
  expect(JSON.stringify(read)).not.toMatch(/PRIVATE_|<script>/);
});
