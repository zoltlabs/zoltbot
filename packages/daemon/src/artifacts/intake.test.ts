import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  artifactLimits,
  artifactOwnerAllowed,
  artifactPath,
  blobBytes,
  importFiles,
  possibleSecret,
  safeFile,
} from "./intake.js";
import { verifiedType } from "./types.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});
async function root() {
  const r = await realpath(await mkdtemp(path.join(os.tmpdir(), "artifact-intake-")));
  roots.push(r);
  return r;
}
async function* inline(files: [string, string | Buffer][]) {
  for (const [path, content] of files) yield { path, bytes: Buffer.from(content) };
}
it("imports hash-named immutable content, verifies every read and flags secrets without echoing them", async () => {
  const r = await root();
  const result = await importFiles(
    r,
    inline([
      ["index.html", "<h1>Hello</h1>"],
      ["style.css", "h1{color:blue}"],
    ]),
  );
  expect(result.files).toHaveLength(2);
  const first = result.files[0];
  if (!first) throw Error("fixture");
  expect((await blobBytes(r, first.hash)).toString()).toBe("<h1>Hello</h1>");
  expect(first.hash).toBe(createHash("sha256").update("<h1>Hello</h1>").digest("hex"));
  const held = await importFiles(r, inline([[".env", "password=synthetic-long-fixture-value"]]));
  expect(held.held).toBe(true);
  expect(held.text).toBe("");
  const privateHeld = await importFiles(r, inline([["note.md", "private fixture"]]), async (s) =>
    s.includes("private"),
  );
  expect(privateHeld.held).toBe(true);
  await expect(
    importFiles(
      r,
      inline([
        ["X.md", "x"],
        ["x.md", "y"],
      ]),
    ),
  ).rejects.toThrow("collision");
  await expect(
    importFiles(
      r,
      inline([
        ["é.md", "x"],
        ["e\u0301.md", "y"],
      ]),
    ),
  ).rejects.toThrow("collision");
});
it("rejects traversal, symlink ancestors, linked files and oversized files for staging AND repository intake", async () => {
  const r = await root();
  for (const p of ["../secret.txt", "/secret.txt", "a/../b", "a\\b", "a//b", "./a", "a\0b"])
    expect(() => artifactPath(p)).toThrow();
  await mkdir(path.join(r, "real"));
  await writeFile(path.join(r, "real", "ok.txt"), "safe");
  await symlink(path.join(r, "real"), path.join(r, "alias"));
  await symlink(path.join(r, "real", "ok.txt"), path.join(r, "link.txt"));
  await expect(safeFile(r, "link.txt")).rejects.toThrow();
  await expect(safeFile(r, "alias/ok.txt")).rejects.toThrow();
  await link(path.join(r, "real", "ok.txt"), path.join(r, "hard.txt"));
  await expect(safeFile(r, "hard.txt")).rejects.toThrow("denied");
  await writeFile(path.join(r, "large.txt"), Buffer.alloc(artifactLimits.file + 1));
  await expect(safeFile(r, "large.txt")).rejects.toThrow("denied");
  await expect(
    importFiles(r, inline([["large.txt", Buffer.alloc(artifactLimits.file + 1)]])),
  ).rejects.toThrow("limit");
});
it("bounds file counts and verifies text encodings, SVG roots, JSON and MIME signatures", async () => {
  const r = await root();
  await expect(
    importFiles(r, inline(Array.from({ length: 501 }, (_, i) => [`${i}.txt`, "x"]))),
  ).rejects.toThrow("limit");
  for (const [name, bytes] of [
    ["fake.png", Buffer.from("<script>alert(1)</script>")],
    ["bad.json", Buffer.from("{")],
    ["bad.txt", Buffer.from([255])],
    ["bad.txt", Buffer.from([0])],
    ["bad.svg", Buffer.from("<html/>")],
  ] as const)
    expect(() => verifiedType(name, bytes)).toThrow();
  expect(
    verifiedType(
      "image.svg",
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
    ),
  ).toBe("image/svg+xml"); // Rendering MUST disable script for this verified SVG MIME.
  for (const text of [
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "Bearer synthetic-long-fixture-value",
    "ghp_aaaaaaaaaaaaaaaaaaaaaaaa",
    "sk-aaaaaaaaaaaaaaaaaaaa",
  ])
    expect(possibleSecret("x.txt", text)).toBe(true);
});

it("permits root-owned shipped assets only when the caller explicitly requests it", () => {
  expect(artifactOwnerAllowed(process.getuid?.() ?? -1)).toBe(true);
  expect(artifactOwnerAllowed(0)).toBe(process.getuid?.() === 0);
  expect(artifactOwnerAllowed(0, true)).toBe(true);
  expect(artifactOwnerAllowed(987654, true)).toBe(false);
});
