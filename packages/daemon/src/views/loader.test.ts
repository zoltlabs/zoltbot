import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openStore } from "@zoltbot/store";
import { afterEach, describe, expect, it } from "vitest";
import { assetServer } from "../api-assets.js";
import { checkedViewPath, loadView, loadViews, viewBundleHash, viewRecord } from "./loader.js";
import { ViewRegistry } from "./registry.js";

const temporary: string[] = [];
afterEach(async () => {
  for (const root of temporary.splice(0)) await rm(root, { recursive: true, force: true });
});
async function root() {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "views-test-")));
  temporary.push(dir);
  return dir;
}
async function fixture(directory: string, extra = {}) {
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "view.json"),
    JSON.stringify({
      manifest: 1,
      id: path.basename(directory),
      name: "Example",
      version: "1.0.0",
      api: 1,
      entry: "index.html",
      slots: ["page"],
      permissions: ["read"],
      ...extra,
    }),
  );
  await writeFile(path.join(directory, "index.html"), "<!doctype html><h1>Example</h1>");
  return directory;
}
describe("view loader", () => {
  it("rejects traversal, normalization changes and case collisions", () => {
    for (const name of [
      "../outside",
      "/outside",
      "a//b",
      "a/./b",
      "a\\b",
      "x%20y",
      "x?y",
      "a\0b",
      "e\u0301.txt",
    ])
      expect(() => checkedViewPath(name, new Set())).toThrow();
    const seen = new Set<string>();
    checkedViewPath("Icon.svg", seen);
    expect(() => checkedViewPath("icon.svg", seen)).toThrow("collision");
  });
  it("hashes a valid bundle deterministically and detects changes", async () => {
    const dir = await fixture(path.join(await root(), "example"));
    const first = await loadView(dir),
      second = await loadView(dir);
    expect(first.bundleHash).toBe(second.bundleHash);
    expect(first.bundleHash).toBe(viewBundleHash(first.manifestBytes, first.files));
    expect(viewRecord(first, first, [])).toMatchObject({
      granted: [],
      source: "builtin",
      overridesBuiltin: false,
    });
    await writeFile(path.join(dir, "index.html"), "Changed");
    expect((await loadView(dir)).bundleHash).not.toBe(first.bundleHash);
  });
  it("lets a valid user view replace the built-in and falls back for a broken override", async () => {
    const dir = await root(),
      builtin = path.join(dir, "builtin"),
      user = path.join(dir, "user");
    await fixture(path.join(builtin, "example"));
    await fixture(path.join(user, "example"), { name: "Custom" });
    const loaded = await loadViews(builtin, user),
      bundle = loaded.bundles.get("example");
    if (!bundle) throw Error("fixture");
    expect(viewRecord(bundle, loaded.builtins.get("example"), []).overridesBuiltin).toBe(true);
    await writeFile(path.join(user, "example", "view.json"), "{");
    const fallback = await loadViews(builtin, user);
    expect(fallback.bundles.get("example")?.manifest.name).toBe("Example");
    expect(fallback.errors).toMatchObject([{ id: "example", source: "user" }]);
  });
  it("rejects symlink roots, entries, and files, and hard-linked files", async () => {
    const dir = await root(),
      view = await fixture(path.join(dir, "example"));
    await symlink(view, path.join(dir, "alias"));
    await expect(loadView(path.join(dir, "alias"))).rejects.toThrow("directory_denied");
    await symlink(path.join(view, "index.html"), path.join(view, "alias.html"));
    await expect(loadView(view)).rejects.toThrow("symlink_denied");
    await rm(path.join(view, "alias.html"));
    await link(path.join(view, "index.html"), path.join(view, "linked.html"));
    await expect(loadView(view)).rejects.toThrow("file_denied");
    const loaded = await loadViews(path.join(dir, "missing"), dir);
    expect(loaded.errors.some((error) => error.id === "alias")).toBe(true);
  });
  it.each([
    "network.wasm",
    "movie.mp4",
    "source.pdf",
    "data.csv",
    "index.htm",
    "key.pem",
  ])("rejects unsupported file %s", async (name) => {
    const view = await fixture(path.join(await root(), "example"));
    await writeFile(path.join(view, name), "invalid");
    await expect(loadView(view)).rejects.toThrow("type_denied");
  });
  it.each(["_host", "_HOST"])("rejects reserved directory %s", async (name) => {
    const view = await fixture(path.join(await root(), "example"));
    await mkdir(path.join(view, name));
    await expect(loadView(view)).rejects.toThrow("reserved_path");
  });
  it("rejects missing entry, missing icon, mismatched id and future API", async () => {
    const view = path.join(await root(), "example");
    await fixture(view, { entry: "missing.html" });
    await expect(loadView(view)).rejects.toThrow("entry_missing");
    await fixture(view, { icon: "missing.svg" });
    await expect(loadView(view)).rejects.toThrow("icon_missing");
    await fixture(view, { id: "other" });
    await expect(loadView(view)).rejects.toThrow("must_match");
    await fixture(view, { api: 2 });
    await expect(loadView(view)).rejects.toThrow("Invalid payload");
  });
  it("rejects binary text, malformed JSON, image spoofing and bad fonts", async () => {
    for (const [name, bytes] of [
      ["text.txt", Buffer.from([0])],
      ["data.json", Buffer.from("{")],
      ["image.png", Buffer.from("invalid")],
      ["font.woff2", Buffer.from("invalid")],
    ] as const) {
      const view = await fixture(path.join(await root(), "example"));
      await writeFile(path.join(view, name), bytes);
      await expect(loadView(view)).rejects.toThrow();
    }
  });
  it("enforces file size, file count and total bytes", async () => {
    const view = await fixture(path.join(await root(), "example"));
    await writeFile(path.join(view, "large.txt"), Buffer.alloc(25 * 1024 * 1024 + 1, 32));
    await expect(loadView(view)).rejects.toThrow("file_denied");
    await rm(path.join(view, "large.txt"));
    for (let i = 0; i < 499; i++) await writeFile(path.join(view, `${i}.txt`), "x");
    await expect(loadView(view)).rejects.toThrow("file_limit");
    const total = await fixture(path.join(await root(), "example"));
    for (let i = 0; i < 4; i++)
      await writeFile(path.join(total, `${i}.txt`), Buffer.alloc(25 * 1024 * 1024, 32));
    await expect(loadView(total)).rejects.toThrow("total_limit");
  });
  it("keeps private manifest metadata out of records and events", async () => {
    const dir = await root(),
      builtin = path.join(dir, "builtin");
    await fixture(path.join(builtin, "example"), { description: "Private fixture" });
    const store = await openStore(path.join(dir, "test.db"));
    try {
      const registry = new ViewRegistry(
        store,
        builtin,
        path.join(dir, "user"),
        () => {},
        async (value) => {
          if (JSON.stringify(value).includes("Private fixture")) throw Error("private_input");
          return () => {};
        },
      );
      const [record] = await registry.reload();
      expect(record?.error?.code).toBe("view_private_metadata");
      expect(JSON.stringify(store.snapshot())).not.toContain("Private fixture");
      expect(JSON.stringify(store.eventsSince(0))).not.toContain("Private fixture");
    } finally {
      store.close();
    }
  });
  it("publishes registry records through the existing projection and authenticates asset routes", async () => {
    const dir = await root(),
      builtin = path.join(dir, "builtin");
    await fixture(path.join(builtin, "example"));
    const store = await openStore(path.join(dir, "test.db")),
      events: unknown[] = [];
    const registry = new ViewRegistry(store, builtin, path.join(dir, "user"), (batch) =>
      events.push(...batch),
    );
    const server = assetServer(
      store,
      "synthetic-owner-token",
      new Set(["zoltbot://desktop"]),
      () => registry,
    );
    try {
      const [record] = await registry.reload();
      if (!record) throw Error("fixture");
      expect(store.record("view", "example")?.bundleHash).toBe(record.bundleHash);
      await registry.reload();
      expect(events).toHaveLength(1);
      await registry.api("view.setEnabled", { id: "example", enabled: false }, "disable");
      expect(store.record("view", "example")?.enabled).toBe(false);
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") throw Error("fixture");
      const url = `http://127.0.0.1:${address.port}/view-manifest/${record.bundleHash}`;
      expect((await fetch(url)).status).toBe(403);
      const headers = { Authorization: "Bearer synthetic-owner-token" };
      expect(
        (await fetch(url, { headers: { ...headers, Origin: "https://example.invalid" } })).status,
      ).toBe(403);
      expect((await fetch(url, { headers })).status).toBe(200);
      const bundle = registry.bundle(record.bundleHash),
        file = bundle?.files.find((entry) => entry.path === "index.html");
      if (!file) throw Error("fixture");
      await writeFile(path.join(builtin, "example", "index.html"), "changed");
      await expect(registry.asset(record.bundleHash, file.hash)).rejects.toThrow("file_changed");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    }
  });
});
