import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ATTACHMENT_POLICY,
  attachmentId,
  attachmentResponse,
  byteRange,
} from "./attachment-protocol";

let dir = "";
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "attachment-protocol-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const request = (url: string, headers: Record<string, string> = {}) =>
  new Request(url, { headers });

describe("attachment protocol", () => {
  it("reads the id from the URL", () => {
    expect(attachmentId("openbot-attachment://file/item%3Aa%3A1")).toBe("item:a:1");
    expect(attachmentId("openbot-attachment://file/")).toBeUndefined();
  });

  it("parses byte ranges", () => {
    expect(byteRange(null, 10)).toBeUndefined();
    expect(byteRange("bytes=2-5", 10)).toEqual({ start: 2, end: 5 });
    expect(byteRange("bytes=4-", 10)).toEqual({ start: 4, end: 9 });
    expect(byteRange("bytes=-3", 10)).toEqual({ start: 7, end: 9 });
    expect(byteRange("bytes=8-100", 10)).toEqual({ start: 8, end: 9 });
    expect(byteRange("bytes=10-", 10)).toBe("invalid");
    expect(byteRange("bytes=0-1,4-5", 10)).toBeUndefined();
  });

  it("streams a range of a video", async () => {
    const path = join(dir, "clip.mp4");
    await writeFile(path, "0123456789");
    const response = await attachmentResponse(
      request("openbot-attachment://file/x", { Range: "bytes=2-5" }),
      { path, mimeType: "video/mp4" },
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe("bytes 2-5/10");
    expect(await response.text()).toBe("2345");
    const bad = await attachmentResponse(
      request("openbot-attachment://file/x", { Range: "bytes=20-" }),
      { path, mimeType: "video/mp4" },
    );
    expect(bad.status).toBe(416);
  });

  it("serves SVG and text under a policy that runs nothing", async () => {
    const path = join(dir, "logo.svg");
    await writeFile(path, "<svg><script>alert(1)</script></svg>");
    const response = await attachmentResponse(request("openbot-attachment://file/x"), {
      path,
      mimeType: "image/svg+xml",
    });
    expect(response.headers.get("Content-Security-Policy")).toBe(ATTACHMENT_POLICY);
    expect(ATTACHMENT_POLICY).toContain("sandbox");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const page = join(dir, "page.html");
    await writeFile(page, "<b>hi</b>");
    const html = await attachmentResponse(request("openbot-attachment://file/x"), {
      path: page,
      mimeType: "text/plain",
    });
    expect(html.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
  });

  it("renders Markdown without raw HTML, links or remote images", async () => {
    const path = join(dir, "plan.md");
    await writeFile(
      path,
      "# Plan\n\n<script>alert(1)</script>\n\n[site](https://example.com) ![x](https://example.com/a.png)",
    );
    const response = await attachmentResponse(
      request("openbot-attachment://file/x?view=markdown"),
      { path, mimeType: "text/markdown" },
    );
    const html = await response.text();
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("Content-Security-Policy")).toBe(ATTACHMENT_POLICY);
    expect(html).toContain("<h1>Plan</h1>");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("href=");
    expect(html).not.toContain("<img");
  });

  it("answers 404 for unknown ids and missing files", async () => {
    expect(
      (await attachmentResponse(request("openbot-attachment://file/x"), undefined)).status,
    ).toBe(404);
    const missing = await attachmentResponse(request("openbot-attachment://file/x"), {
      path: join(dir, "gone.csv"),
      mimeType: "text/csv",
    });
    expect(missing.status).toBe(404);
  });

  it("streams a large file in pieces instead of reading it whole", async () => {
    const path = join(dir, "clip.mp4");
    await writeFile(path, Buffer.alloc(12 * 1024 * 1024, 7));
    const response = await attachmentResponse(request("openbot-attachment://file/x"), {
      path,
      mimeType: "video/mp4",
    });
    expect(response.headers.get("Content-Length")).toBe(String(12 * 1024 * 1024));
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read();
    // The first piece arrives long before the whole file is read.
    expect(first.value?.byteLength).toBeLessThanOrEqual(64 * 1024);
    await reader.cancel();
  });

  it("lists a ZIP's files as JSON and refuses one it can't read", async () => {
    const name = Buffer.from("a.txt");
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt32LE(4, 24);
    entry.writeUInt16LE(name.length, 28);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(46 + name.length, 12);
    const good = join(dir, "bundle.zip");
    await writeFile(good, Buffer.concat([entry, name, end]));
    const response = await attachmentResponse(request("openbot-attachment://file/x?view=zip"), {
      path: good,
      mimeType: "application/zip",
    });
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(await response.json()).toEqual({
      entries: [{ name: "a.txt", size: 4 }],
      files: 1,
      unpacked: 4,
    });
    const bad = join(dir, "broken.zip");
    await writeFile(bad, "not a zip");
    const refused = await attachmentResponse(request("openbot-attachment://file/x?view=zip"), {
      path: bad,
      mimeType: "application/zip",
    });
    expect(refused.status).toBe(422);
  });
});
