import { readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { InteractionSchema, parse } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { viewToolFixture } from "./tool-fixture.js";

const css = "body { color: var(--zb-accent-text); }";
it("reads checked source in bounded pages and rejects cross-file cursors and out-of-bundle paths", async () => {
  const f = await viewToolFixture();
  try {
    const list = (await f.call({ action: "list" })) as {
      items: { id: string; bundleHash: string }[];
    };
    expect(list.items).toHaveLength(1);
    expect(JSON.stringify(list).length).toBeLessThan(3800);
    const bundleHash = list.items[0]?.bundleHash;
    const metadata = (await f.call({ action: "read", id: "example" })) as {
      files: { path: string }[];
    };
    expect(metadata.files.map((file) => file.path)).toContain("vendor.js");
    let cursor: string | null = null,
      text = "";
    do {
      const page = (await f.call({
        action: "read",
        id: "example",
        bundleHash,
        path: "vendor.js",
        ...(cursor ? { cursor } : {}),
      })) as { text: string; cursor: string | null; untrusted: boolean };
      expect(JSON.stringify(page).length).toBeLessThanOrEqual(3800);
      expect(page.untrusted).toBe(true);
      text += page.text;
      cursor = page.cursor;
      if (cursor)
        await expect(
          f.call({ action: "read", id: "example", bundleHash, path: "style.css", cursor }),
        ).rejects.toThrow("cursor_invalid");
    } while (cursor);
    expect(text).toBe(await readFile(path.join(f.registry.builtin, "example/vendor.js"), "utf8"));
    await expect(
      f.call({ action: "read", id: "example", bundleHash, path: "../outside" }),
    ).rejects.toThrow("file_not_found");
  } finally {
    await f.close();
  }
});
it("freezes an outside-chat edit, requires durable owner consent, applies it with lineage and leaves grants unchanged", async () => {
  const f = await viewToolFixture();
  try {
    await f.registry.api(
      "view.setGrants",
      { id: "example", permissions: ["read"], confirmed: true },
      "grant",
    );
    const baseHash = f.context.store.record("view", "example")?.bundleHash,
      dir = await f.stage({ "style.css": css });
    const pending = (await f.call(
      { action: "save", id: "example", baseHash, source: { dir }, key: "colors" },
      "save",
    )) as { status: string; requestId: string };
    expect(pending.status).toBe("pending");
    expect(f.context.store.record("view", "example")?.source).toBe("builtin");
    const request = parse(
      InteractionSchema,
      f.context.store.record("interaction", pending.requestId),
    );
    expect(request.context?.markdown).toContain("style.css");
    expect(request.context?.markdown).toContain("view.json");
    expect(request.context?.markdown).not.toContain("vendor.js");
    await writeFile(path.join(f.f.root, dir, "style.css"), "body { color: var(--zb-attention); }");
    expect(
      await f.call(
        { action: "save", id: "example", baseHash, source: { dir }, key: "colors" },
        "save",
      ),
    ).toEqual(pending);
    f.change({ type: "transition", kind: "turn", id: "turn", to: "completed" });
    await f.engine.answer(
      request.id,
      request.version,
      {
        action: "accept",
        choice: "allow_once",
        by: { kind: "human", id: "local-owner" },
        at: new Date().toISOString(),
      },
      "approve",
      { kind: "human", id: "local-owner" },
    );
    expect(await readFile(path.join(f.registry.user, "example/style.css"), "utf8")).toBe(css);
    expect(f.context.store.record("view", "example")).toMatchObject({
      source: "user",
      granted: ["read"],
      basedOn: { id: "example", bundleHash: baseHash },
    });
    expect(f.context.store.snapshot().audit).toContainEqual(
      expect.objectContaining({
        action: "view.save",
        detail: expect.objectContaining({ confirmed: true, interactionId: request.id }),
      }),
    );
  } finally {
    await f.close();
  }
});
it("keeps owner edits made while a proposal waits and does not replace them after approval", async () => {
  const f = await viewToolFixture();
  try {
    await f.registry.api("view.customize", { id: "example" }, "customize");
    const baseHash = f.context.store.record("view", "example")?.bundleHash,
      dir = await f.stage({ "style.css": css });
    const pending = (await f.call({
      action: "save",
      id: "example",
      baseHash,
      source: { dir },
      key: "colors",
    })) as { requestId: string };
    await writeFile(path.join(f.registry.user, "example/style.css"), "/* Owner edit */");
    await f.registry.reload();
    const request = parse(
      InteractionSchema,
      f.context.store.record("interaction", pending.requestId),
    );
    await f.engine.answer(
      request.id,
      request.version,
      {
        action: "accept",
        choice: "allow_once",
        by: { kind: "human", id: "local-owner" },
        at: new Date().toISOString(),
      },
      "approve-stale",
      { kind: "human", id: "local-owner" },
    );
    expect(await readFile(path.join(f.registry.user, "example/style.css"), "utf8")).toBe(
      "/* Owner edit */",
    );
    expect(JSON.stringify(f.context.store.snapshot().item)).toContain("could not be applied");
  } finally {
    await f.close();
  }
});
it("holds an approved edit if its proposed text becomes private while waiting", async () => {
  const f = await viewToolFixture();
  try {
    const secret = "synthetic-private-after-proposal";
    const dir = await f.stage({ "style.css": `/* ${secret} */` });
    const pending = (await f.call({
      action: "save",
      id: "example",
      baseHash: f.context.store.record("view", "example")?.bundleHash,
      source: { dir },
      key: "private-later",
    })) as { requestId: string };
    f.context.privacy.remember(secret);
    const request = parse(
      InteractionSchema,
      f.context.store.record("interaction", pending.requestId),
    );
    await f.engine.answer(
      request.id,
      request.version,
      {
        action: "accept",
        choice: "allow_once",
        by: { kind: "human", id: "local-owner" },
        at: new Date().toISOString(),
      },
      "approve-private",
      { kind: "human", id: "local-owner" },
    );
    expect(f.context.store.record("view", "example")?.source).toBe("builtin");
    expect(JSON.stringify(f.context.store.snapshot())).not.toContain(secret);
  } finally {
    await f.close();
  }
});
it("creates permissionless views and edits its own chat's view without a new consent request", async () => {
  const f = await viewToolFixture();
  try {
    const manifest = {
      manifest: 1,
      id: "mine",
      name: "Mine",
      version: "1.0.0",
      api: 1,
      entry: "index.html",
      slots: ["page"],
      permissions: ["read"],
      granted: ["act", "approve"],
    };
    const dir = await f.stage({
      "view.json": JSON.stringify(manifest),
      "index.html": "<h1>Mine</h1>",
    });
    expect(await f.call({ action: "save", id: "mine", source: { dir }, key: "new" })).toMatchObject(
      { status: "saved", href: "#view/mine" },
    );
    expect(f.context.store.record("view", "mine")?.granted).toEqual([]);
    const baseHash = f.context.store.record("view", "mine")?.bundleHash,
      edit = await f.stage({ "index.html": "<h1>Edited</h1>" });
    expect(
      await f.call({ action: "save", id: "mine", baseHash, source: { dir: edit }, key: "edit" }),
    ).toMatchObject({ status: "saved" });
    expect(f.context.store.snapshot().interaction ?? []).toHaveLength(0);
    expect(f.context.store.record("view", "mine")?.granted).toEqual([]);
  } finally {
    await f.close();
  }
});
it("declines proposed edits and rejects secrets, staging symlinks, stale hashes and missing authority", async () => {
  const f = await viewToolFixture();
  try {
    const baseHash = f.context.store.record("view", "example")?.bundleHash,
      dir = await f.stage({ "style.css": css });
    const pending = (await f.call({
      action: "save",
      id: "example",
      baseHash,
      source: { dir },
      key: "colors",
    })) as { requestId: string };
    const request = parse(
      InteractionSchema,
      f.context.store.record("interaction", pending.requestId),
    );
    await f.engine.answer(
      request.id,
      request.version,
      {
        action: "decline",
        choice: "reject_once",
        by: { kind: "human", id: "local-owner" },
        at: new Date().toISOString(),
      },
      "decline",
      { kind: "human", id: "local-owner" },
    );
    expect(f.context.store.record("view", "example")?.source).toBe("builtin");
    await expect(
      f.call({
        action: "save",
        id: "example",
        baseHash: "a".repeat(64),
        source: { dir },
        key: "stale",
      }),
    ).rejects.toThrow("view_changed");
    const secret = "synthetic-protected-view-value";
    f.context.privacy.remember(secret);
    const privateDir = await f.stage({ "style.css": `/* ${secret} */` });
    await expect(
      f.call({
        action: "save",
        id: "example",
        baseHash,
        source: { dir: privateDir },
        key: "private",
      }),
    ).rejects.toThrow();
    expect(JSON.stringify(f.context.store.snapshot())).not.toContain(secret);
    const linked = await f.stage({ "unused.txt": "staged" });
    await symlink(path.join(f.f.root, dir, "style.css"), path.join(f.f.root, linked, "style.css"));
    await expect(
      f.call({ action: "save", id: "example", baseHash, source: { dir: linked }, key: "symlink" }),
    ).rejects.toThrow("symlink");
    expect(f.tools.authorize({ ...f.actor, threadId: "foreign" }, { action: "save" })).toBe(false);
    expect(f.tools.authorize(f.actor, { action: "save" })).toBe(true);
    f.change({
      type: "update",
      kind: "agent",
      id: "profile",
      changes: { permissionProfile: "read_only" },
      confirmed: true,
    });
    expect(f.tools.authorize(f.actor, { action: "save" })).toBe(false);
    expect(f.tools.authorize(f.actor, { action: "list" })).toBe(true);
  } finally {
    await f.close();
  }
});
