import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { cloudAccount } from "./cloud-account.js";

const temporary: string[] = [];
afterEach(async () => {
  for (const directory of temporary.splice(0))
    await rm(directory, { recursive: true, force: true });
});
const id = "ab111111-1111-4111-8111-111111111111";
const oldId = "ab222222-2222-4222-8222-222222222222";
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "zolt-sharing-"));
  temporary.push(directory);
  const referenceFile = path.join(directory, "reference");
  await writeFile(referenceFile, "keychain:test");
  const blob = Buffer.from("<!doctype html><h1>Version two</h1>");
  const manifest = {
    version: 1,
    entry: "index.html",
    screens: [],
    files: [{ path: "index.html", hash: sha(blob), bytes: blob.length, mime: "text/html" }],
  };
  const bytes = Buffer.from(JSON.stringify(manifest));
  const digest = sha(bytes);
  let visibility: "private" | "public" = "private";
  let denied = false;
  let mismatch = false;
  const clipboard = vi.fn();
  const transport = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    expect(init?.headers).toMatchObject({
      Authorization: expect.stringMatching(/^(Bearer|Refresh) /),
    });
    if (denied) return Response.json({}, { status: 401 });
    if (url.pathname === "/api/account/artifacts" && init?.method === "GET")
      return Response.json({
        artifacts: [
          { id: oldId, title: "Design" },
          { id, title: "Design" },
        ],
      });
    if (url.pathname.endsWith("/view"))
      return Response.json({
        title: "Design",
        visibility,
        manifestHash: url.pathname.includes(oldId) || mismatch ? "f".repeat(64) : digest,
        url: "https://content.example/content/secret-capability/index.html",
      });
    if (url.pathname.endsWith("/visibility")) {
      const payload = JSON.parse(String(init?.body));
      expect(payload).toEqual({
        visibility: expect.stringMatching(/^(private|public)$/),
        confirm: true,
        manifestHash: digest,
      });
      visibility = payload.visibility;
      return Response.json({ visibility });
    }
    if (url.pathname === "/api/account/artifacts" && init?.method === "POST")
      return Response.json({ id, state: "ready", uploaded: [sha(blob)] });
    throw new Error("unexpected_request");
  }) as unknown as typeof fetch;
  const controller = cloudAccount({
    origin: "https://zoltbot.ai",
    referenceFile,
    deviceName: "Test",
    fetch: transport,
    secrets: {
      async read() {
        return { accessToken: "a".repeat(43), refreshToken: "r".repeat(43), sessionId: "session" };
      },
      async put() {
        return { reference: "keychain:test" };
      },
      async replace() {},
      async remove() {},
    },
    async openBrowser() {
      throw new Error("browser_must_not_open");
    },
    async readArtifact(kind) {
      return kind === "manifest" ? bytes : blob;
    },
    writeClipboard: clipboard,
  });
  return {
    controller,
    transport,
    clipboard,
    digest,
    deny: () => {
      denied = true;
    },
    mismatch: () => {
      mismatch = true;
    },
  };
}
it("finds the exact saved version and strips content capabilities from IPC results", async () => {
  const f = await fixture();
  const result = await f.controller.findArtifact(f.digest, "Design");
  expect(result).toEqual({ id, visibility: "private", url: `https://zoltbot.ai/s/${id}` });
  expect(JSON.stringify(result)).not.toContain("secret-capability");
  expect(JSON.stringify(result)).not.toContain("a".repeat(43));
});
it("requires confirmation and binds visibility changes to the selected immutable version", async () => {
  const f = await fixture();
  const input = {
    id,
    hash: f.digest,
    title: "Design",
    visibility: "public" as const,
    confirm: true as const,
  };
  await expect(
    f.controller.setArtifactVisibility({ ...input, confirm: false as unknown as true }),
  ).rejects.toThrow("publication_confirmation_required");
  expect(f.transport).not.toHaveBeenCalled();
  expect(await f.controller.setArtifactVisibility(input)).toMatchObject({ visibility: "public" });
  expect(
    await f.controller.setArtifactVisibility({ ...input, visibility: "private" }),
  ).toMatchObject({ visibility: "private" });
  f.mismatch();
  const before = vi.mocked(f.transport).mock.calls.length;
  await expect(f.controller.setArtifactVisibility(input)).rejects.toThrow(
    "artifact_version_mismatch",
  );
  expect(
    vi
      .mocked(f.transport)
      .mock.calls.slice(before)
      .every(([, init]) => init?.method === "GET"),
  ).toBe(true);
});
it("copies only a constructed owned share link, and denies invalid or revoked access", async () => {
  const f = await fixture();
  await f.controller.copyArtifactLink(id);
  expect(f.clipboard).toHaveBeenCalledWith(`https://zoltbot.ai/s/${id}`);
  await expect(f.controller.copyArtifactLink("../sessions")).rejects.toThrow("invalid_artifact_id");
  f.deny();
  await expect(f.controller.copyArtifactLink(id)).rejects.toThrow("sign_in_required");
  expect(f.clipboard).toHaveBeenCalledTimes(1);
});
it("resumes an uploaded snapshot without resetting its public visibility", async () => {
  const f = await fixture();
  await f.controller.setArtifactVisibility({
    id,
    hash: f.digest,
    title: "Design",
    visibility: "public",
    confirm: true,
  });
  expect(await f.controller.uploadArtifact(f.digest, "Design", id, true)).toEqual({
    id,
    visibility: "public",
    url: `https://zoltbot.ai/s/${id}`,
  });
});
