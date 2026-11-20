import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  type ArtifactShareRecord,
  ARTIFACT_SHARE_CHANNELS as C,
} from "../../shared/artifact-share";
import { artifactShareHandlers } from "./artifact-share";
import { cloudAccount } from "./cloud-account";

const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const id = "ab111111-1111-4111-8111-111111111111";
const oldId = "ab222222-2222-4222-8222-222222222222";
const blob = Buffer.from("<!doctype html><h1>Version two</h1>");
const manifest = Buffer.from(
  JSON.stringify({
    version: 1,
    entry: "index.html",
    screens: [],
    files: [{ path: "index.html", hash: sha(blob), bytes: blob.length, mime: "text/html" }],
  }),
);
const digest = sha(manifest);

/** A cloud account whose session answers from a table of the account service's routes. */
function account(online: { id: string; hash: string }[]) {
  const request = vi.fn(async (route: string, method = "GET") => {
    if (route === "/artifacts" && method === "GET")
      return { artifacts: online.map((item) => ({ id: item.id, title: "Design" })) };
    const view = route.match(/^\/artifacts\/([^/]+)\/view$/);
    const item = online.find((entry) => entry.id === view?.[1]);
    if (item)
      return {
        title: "Design",
        visibility: "private",
        manifestHash: item.hash,
        url: "https://content.example/secret-capability/index.html",
      };
    if (method === "DELETE") return {};
    throw new Error("unexpected_request");
  });
  const controller = cloudAccount({
    origin: "https://zoltbot.example",
    referenceFile: "/nonexistent/reference",
    deviceName: "Test",
    nativeSession: {
      status: vi.fn(),
      save: vi.fn(),
      clear: vi.fn(),
      request,
      sessionId: () => "session",
    } as never,
    async openBrowser() {
      throw new Error("browser_must_not_open");
    },
    async readArtifact(kind) {
      return kind === "manifest" ? manifest : blob;
    },
  });
  return { controller, request };
}

describe("cloud account links", () => {
  it("looks a link up by id with one view call, without content capabilities", async () => {
    const { controller, request } = account([{ id, hash: digest }]);
    const link = await controller.artifactLink(id, digest);
    expect(link).toEqual({
      id,
      visibility: "private",
      url: `https://zoltbot.example/s/${id}`,
      current: true,
    });
    expect(JSON.stringify(link)).not.toContain("secret-capability");
    expect(request.mock.calls.filter(([route]) => String(route).endsWith("/view"))).toHaveLength(1);
  });

  it("says when the link shows an older version", async () => {
    const { controller } = account([{ id: oldId, hash: "f".repeat(64) }]);
    expect(await controller.artifactLink(oldId, digest)).toMatchObject({ current: false });
  });

  it("deletes a link only by a valid id, with confirmation", async () => {
    const { controller, request } = account([]);
    await controller.deleteArtifact(id);
    expect(request).toHaveBeenCalledWith(
      `/artifacts/${id}`,
      "DELETE",
      JSON.stringify({ confirm: true }),
    );
    await expect(controller.deleteArtifact("../sessions")).rejects.toThrow();
  });
});

const READY = {
  configured: true,
  signedIn: true,
  account: { capabilities: { privateArtifacts: true }, organizations: [{ id: "org" }] },
};
const LINK = {
  id,
  visibility: "private" as "private" | "public",
  url: `https://zoltbot.example/s/${id}`,
};
const target = { artifactId: "art-1", manifestHash: digest, title: "Design" };
const RECORD = { ...LINK, manifestHash: digest };

function fake(status: unknown = READY) {
  return {
    status: vi.fn(async () => status),
    artifactLink: vi.fn(async (): Promise<typeof LINK & { current: boolean }> => {
      throw new Error("account_service_unavailable");
    }),
    uploadArtifact: vi.fn(async () => LINK),
    setArtifactVisibility: vi.fn(async (input: { visibility: "private" | "public" }) => ({
      ...LINK,
      visibility: input.visibility,
    })),
    deleteArtifact: vi.fn(async () => {}),
    copyArtifactLink: vi.fn(async () => ({ url: LINK.url })),
  };
}

function store(initial: ArtifactShareRecord | null = null) {
  let value = initial;
  return {
    get: vi.fn(() => value),
    set: vi.fn(async (_id: string, next: ArtifactShareRecord | null) => {
      value = next;
    }),
  };
}

describe("Share handlers", () => {
  it("says why the panel can't share", async () => {
    const run = (status: unknown) =>
      artifactShareHandlers(fake(status) as never, store())[C.artifactShareStatus](target);
    expect(await run({ configured: false })).toEqual({ kind: "unavailable" });
    expect(await run({ configured: true, signedIn: false })).toEqual({ kind: "signed-out" });
    expect(await run({ ...READY, account: { ...READY.account, capabilities: {} } })).toEqual({
      kind: "unavailable",
    });
    expect(await run(READY)).toEqual({ kind: "ready", link: null });
  });

  it("shows the recorded link, from the account when online and from the record offline", async () => {
    const account = fake();
    const handlers = artifactShareHandlers(account as never, store(RECORD));
    expect(await handlers[C.artifactShareStatus](target)).toEqual({
      kind: "ready",
      link: { ...LINK, current: true },
    });
    account.artifactLink.mockResolvedValue({ ...LINK, visibility: "public", current: true });
    expect(await handlers[C.artifactShareStatus](target)).toMatchObject({
      link: { visibility: "public" },
    });
    expect(account.artifactLink).toHaveBeenCalledWith(id, digest);
  });

  it("publishes as public with a fresh upload key and records the link", async () => {
    const account = fake();
    const records = store();
    const handlers = artifactShareHandlers(account as never, records);
    const link = await handlers[C.artifactSharePublish]({ ...target, visibility: "public" });
    expect(account.uploadArtifact).toHaveBeenCalledWith(
      digest,
      "Design",
      "org",
      true,
      expect.any(String),
    );
    expect(account.setArtifactVisibility).toHaveBeenCalledWith(
      expect.objectContaining({ id, visibility: "public", confirm: true }),
    );
    expect(link).toEqual({ ...LINK, visibility: "public", current: true });
    expect(records.set).toHaveBeenCalledWith("art-1", { ...RECORD, visibility: "public" });
    await expect(
      handlers[C.artifactSharePublish]({ ...target, visibility: "public" }),
    ).rejects.toThrow("This link changed.");
  });

  it("replaces an older link: takes it down first, then publishes this version", async () => {
    const account = fake();
    const records = store({ ...RECORD, id: oldId, manifestHash: "f".repeat(64) });
    const handlers = artifactShareHandlers(account as never, records);
    await expect(
      handlers[C.artifactShareSetVisibility]({ ...target, visibility: "public" }),
    ).rejects.toThrow("This link changed.");
    const link = await handlers[C.artifactShareReplace](target);
    expect(account.deleteArtifact).toHaveBeenCalledWith(oldId);
    expect(account.deleteArtifact.mock.invocationCallOrder[0]).toBeLessThan(
      account.uploadArtifact.mock.invocationCallOrder[0] ?? 0,
    );
    expect(link).toMatchObject({ id, current: true });
  });

  it("only touches the recorded copy", async () => {
    const account = fake();
    const handlers = artifactShareHandlers(account as never, store());
    await expect(handlers[C.artifactShareUnpublish](target)).rejects.toThrow("This link changed.");
    await expect(handlers[C.artifactShareCopy](target)).rejects.toThrow("This link changed.");
    expect(account.deleteArtifact).not.toHaveBeenCalled();
    const records = store(RECORD);
    await artifactShareHandlers(account as never, records)[C.artifactShareUnpublish](target);
    expect(account.deleteArtifact).toHaveBeenCalledWith(id);
    expect(records.set).toHaveBeenCalledWith("art-1", null);
  });

  it("turns error codes into sentences", async () => {
    const account = fake();
    account.uploadArtifact.mockRejectedValue(new Error("possible_secret"));
    const handlers = artifactShareHandlers(account as never, store());
    await expect(
      handlers[C.artifactSharePublish]({ ...target, visibility: "private" }),
    ).rejects.toThrow("may contain a secret");
    account.uploadArtifact.mockRejectedValue(new Error("account_service_unavailable"));
    await expect(
      handlers[C.artifactSharePublish]({ ...target, visibility: "private" }),
    ).rejects.toThrow("Couldn’t publish. Check your connection and try again.");
    await expect(
      handlers[C.artifactSharePublish]({ ...target, manifestHash: "x", visibility: "public" }),
    ).rejects.toThrow("Couldn’t share this artifact.");
    expect(account.uploadArtifact).toHaveBeenCalledTimes(2);
  });
});
