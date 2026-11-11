import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { exists } from "./files.js";
import { readViewState, writeViewState } from "./state.js";
import { viewFixture } from "./test-fixture.js";

it("imports without grants, removes immediately after confirmed audit, preserves state and resets grants on reimport", async () => {
  const f = await viewFixture();
  try {
    const source = path.join(f.root, "download/imported");
    await mkdir(source, { recursive: true });
    const manifest = JSON.parse(await readFile(path.join(f.builtin, "example/view.json"), "utf8"));
    manifest.id = "imported";
    manifest.basedOn = { id: "example", version: "1.0.0", bundleHash: "a".repeat(64) };
    manifest.granted = ["read", "act", "approve"];
    await writeFile(path.join(source, "view.json"), JSON.stringify(manifest));
    await writeFile(path.join(source, "index.html"), "<h1>Imported</h1>");
    await expect(f.registry.api("view.import", { path: source }, "deny-import")).rejects.toThrow(
      "confirmation_required",
    );
    const imported = await f.registry.api(
      "view.import",
      { path: source, confirmed: true },
      "import",
    );
    expect(imported).toMatchObject({ id: "imported", source: "user", granted: [], reviewed: [] });
    expect(f.store.record("view", "imported")?.basedOn).toBeUndefined();
    await f.registry.api(
      "view.setGrants",
      { id: "imported", permissions: ["read", "act", "approve"], confirmed: true },
      "grant",
    );
    await writeViewState(f.registry, "imported", { groups: ["chat"] });
    await expect(f.registry.api("view.remove", { id: "imported" }, "deny-remove")).rejects.toThrow(
      "confirmation_required",
    );
    expect(await exists(path.join(f.registry.user, "imported"))).toBeTruthy();
    const removed = await f.registry.api(
      "view.remove",
      { id: "imported", confirmed: true },
      "remove",
    );
    expect(removed).toMatchObject({ removed: true, enabled: false, granted: [] });
    expect(await exists(path.join(f.registry.user, "imported"))).toBeUndefined();
    expect(await exists(path.join(f.registry.user, ".removed"))).toBeUndefined();
    expect(await readViewState(f.registry, "imported")).toEqual({ groups: ["chat"] });
    expect(f.store.snapshot().audit).toContainEqual(
      expect.objectContaining({
        action: "view.remove",
        target: "imported",
        detail: { confirmed: true },
      }),
    );
    await f.registry.reload();
    expect(f.store.record("view", "imported")?.removed).toBe(true);
    const again = await f.registry.api(
      "view.import",
      { path: source, confirmed: true },
      "reimport",
    );
    expect(again).toMatchObject({ granted: [], reviewed: [], enabled: true });
    expect(again).not.toHaveProperty("removed");
    expect(await readViewState(f.registry, "imported")).toEqual({ groups: ["chat"] });
    expect(
      await f.registry.api("view.import", { path: source, confirmed: true }, "reimport"),
    ).toEqual(again);
  } finally {
    await f.close();
  }
});
it("removes an override immediately, revealing the builtin with its existing grants and saved state", async () => {
  const f = await viewFixture();
  try {
    await f.registry.api("view.customize", { id: "example" }, "customize");
    await f.registry.api(
      "view.setGrants",
      { id: "example", permissions: ["read"], confirmed: true },
      "grant",
    );
    await writeViewState(f.registry, "example", { camera: 10 });
    const removed = await f.registry.api(
      "view.remove",
      { id: "example", confirmed: true },
      "remove",
    );
    expect(removed).toMatchObject({ source: "builtin", granted: ["read"] });
    expect(await exists(path.join(f.registry.user, "example"))).toBeUndefined();
    expect(await readViewState(f.registry, "example")).toEqual({ camera: 10 });
    expect(await readFile(path.join(f.builtin, "example/index.html"), "utf8")).toBe(
      "<h1>Example</h1>",
    );
  } finally {
    await f.close();
  }
});
it("never overwrites an installed folder during import, and permits confirmed removal of a broken override", async () => {
  const f = await viewFixture();
  try {
    await f.registry.api("view.customize", { id: "example" }, "customize");
    await expect(
      f.registry.api(
        "view.import",
        { path: path.join(f.builtin, "example"), confirmed: true },
        "import",
      ),
    ).rejects.toThrow("folder_exists");
    await writeFile(path.join(f.registry.user, "example/view.json"), "broken");
    await f.registry.reload();
    expect(f.store.record("view", "example")).toMatchObject({
      source: "builtin",
      error: { code: "view_invalid_user" },
    });
    await f.registry.api("view.remove", { id: "example", confirmed: true }, "remove");
    expect(await exists(path.join(f.registry.user, "example"))).toBeUndefined();
    expect(f.store.record("view", "example")?.error).toBeUndefined();
  } finally {
    await f.close();
  }
});
