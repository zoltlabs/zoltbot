import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { forkFixture } from "../../../tools/fakes/src/fork-fixture.js";
import { attachmentPreviewApi, PHONE_PREVIEW_BYTES } from "./attachment-preview-api.js";

type Preview = {
  kind: string;
  name: string;
  size: number;
  stamp: string;
  data: string;
  next: number | null;
};

async function fixture(input: unknown[], origin?: string, cwd?: string) {
  const f = await forkFixture();
  if (cwd)
    f.put("session", {
      ...f.store.snapshot().session?.[0],
      id: "preview-session",
      threadId: "thread",
      cwd,
      startedAt: "2026-11-21T00:00:00.000Z",
    });
  const dir = await mkdtemp(path.join(tmpdir(), "attachment-preview-"));
  const base = f.store.record("item", "source-message") ?? {};
  f.put("item", {
    ...base,
    id: "sent",
    threadId: "thread",
    kind: "user",
    seq: 90,
    body: { input, ...(origin ? { origin } : {}) },
  });
  const api = attachmentPreviewApi({ store: f.store });
  const preview = (part: number, extra: Record<string, unknown> = {}) =>
    api("attachment.preview", {
      threadId: "thread",
      itemId: "sent",
      part,
      ...extra,
    }) as Promise<Preview>;
  return {
    ...f,
    dir,
    preview,
    api,
    async done() {
      f.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

it("reads the owner's CSV and Markdown parts as text", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "attachment-src-"));
  const csv = path.join(dir, "sales.csv");
  const md = path.join(dir, "plan.md");
  await writeFile(csv, "a,b\n1,2\n");
  await writeFile(md, "# Plan");
  const f = await fixture(
    [
      { type: "text", text: "look" },
      { type: "file", path: csv },
      { type: "file", path: md },
    ],
    undefined,
    dir,
  );
  try {
    expect(await f.preview(1)).toMatchObject({
      kind: "csv",
      name: "sales.csv",
      size: 8,
      data: "a,b\n1,2\n",
      next: null,
    });
    expect(await f.preview(2)).toMatchObject({ kind: "markdown", data: "# Plan" });
    // The text part, a missing part and an unknown item have nothing to preview.
    await expect(f.preview(0)).rejects.toThrow("attachment_preview_unavailable");
    await expect(f.preview(9)).rejects.toThrow("attachment_preview_unavailable");
    await expect(
      f.api("attachment.preview", { threadId: "other", itemId: "sent", part: 1 }),
    ).rejects.toThrow("attachment_preview_unavailable");
  } finally {
    await f.done();
    await rm(dir, { recursive: true, force: true });
  }
});

it("never reads files an agent's message names, or kinds the phone can't show", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "attachment-src-"));
  const csv = path.join(dir, "x.csv");
  const zip = path.join(dir, "x.zip");
  await writeFile(csv, "a\n");
  await writeFile(zip, "PK");
  const fromAgent = await fixture([{ type: "file", path: csv }], "agent", dir);
  try {
    await expect(fromAgent.preview(0)).rejects.toThrow("attachment_preview_unavailable");
  } finally {
    await fromAgent.done();
  }
  const f = await fixture(
    [
      { type: "file", path: zip },
      { type: "file", path: "relative.csv" },
      { type: "file", path: path.join(dir, "gone.csv") },
      { type: "file", path: dir.concat(".csv") },
    ],
    undefined,
    dir,
  );
  try {
    for (const part of [0, 1, 2, 3])
      await expect(f.preview(part)).rejects.toThrow("attachment_preview_unavailable");
  } finally {
    await f.done();
    await rm(dir, { recursive: true, force: true });
  }
});

it("refuses files over 5 MB and returns big ones in pieces that join back", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "attachment-src-"));
  const big = path.join(dir, "big.txt");
  const long = path.join(dir, "long.txt");
  const link = path.join(dir, "link.txt");
  await writeFile(big, Buffer.alloc(PHONE_PREVIEW_BYTES + 1, 97));
  // An emoji straddles the first piece's end, so the split must not break it.
  const text = `${"x".repeat(99_999)}😀${"y".repeat(150_000)}`;
  await writeFile(long, text);
  await symlink(long, link);
  const f = await fixture(
    [
      { type: "file", path: big },
      { type: "file", path: long },
      { type: "file", path: link },
    ],
    undefined,
    dir,
  );
  try {
    await expect(f.preview(0)).rejects.toThrow("attachment_preview_too_large");
    let piece = await f.preview(1);
    let joined = piece.data;
    const stamp = piece.stamp;
    while (piece.next !== null) {
      piece = await f.preview(1, { offset: piece.next, stamp });
      joined += piece.data;
    }
    expect(joined).toBe(text);
    await expect(f.preview(1, { offset: 0, stamp: "stale" })).rejects.toThrow("attachment_changed");
    // A link the owner attached reads its target.
    expect((await f.preview(2)).name).toBe("link.txt");
  } finally {
    await f.done();
    await rm(dir, { recursive: true, force: true });
  }
});

it("returns an inline photo as base64", async () => {
  const f = await fixture([{ type: "image", base64: "aGVsbG8=", mimeType: "image/png" }]);
  try {
    expect(await f.preview(0)).toMatchObject({
      kind: "image",
      mime: "image/png",
      size: 5,
      data: "aGVsbG8=",
      next: null,
    });
  } finally {
    await f.done();
  }
});

it("refuses files outside the chat's workspace or in a hidden folder", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "attachment-src-"));
  const other = await mkdtemp(path.join(tmpdir(), "attachment-other-"));
  await mkdir(path.join(dir, ".config"));
  const secret = path.join(dir, ".config", "hosts.yml.txt");
  const outside = path.join(other, "notes.txt");
  const escape = path.join(dir, "escape.txt");
  await writeFile(secret, "token");
  await writeFile(outside, "elsewhere");
  await symlink(outside, escape);
  const f = await fixture(
    [
      { type: "file", path: secret },
      { type: "file", path: outside },
      { type: "file", path: escape },
    ],
    undefined,
    dir,
  );
  const noWorkspace = await fixture([{ type: "file", path: outside }]);
  try {
    for (const part of [0, 1, 2])
      await expect(f.preview(part)).rejects.toThrow("attachment_preview_unavailable");
    await expect(noWorkspace.preview(0)).rejects.toThrow("attachment_preview_unavailable");
  } finally {
    await f.done();
    await noWorkspace.done();
    await rm(dir, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
  }
});
