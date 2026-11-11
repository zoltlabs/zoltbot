import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { exists } from "./files.js";
import { loadView } from "./loader.js";
import { readViewState, writeViewState } from "./state.js";
import { viewFixture } from "./test-fixture.js";

it("customizes checked builtin files, records basedOn and retains database grants", async () => {
  const f = await viewFixture();
  try {
    const base = await loadView(path.join(f.builtin, "example"));
    await f.registry.api(
      "view.setGrants",
      { id: "example", permissions: ["read"], confirmed: true },
      "grant",
    );
    const record = await f.registry.api("view.customize", { id: "example" }, "customize");
    expect(record).toMatchObject({
      source: "user",
      overridesBuiltin: true,
      granted: ["read"],
      basedOn: { id: "example", version: "1.0.0", bundleHash: base.bundleHash },
    });
    expect(
      JSON.parse(await readFile(path.join(f.registry.user, "example/view.json"), "utf8")).basedOn,
    ).toEqual({ id: "example", version: "1.0.0", bundleHash: base.bundleHash });
    expect(await f.registry.api("view.customize", { id: "example" }, "customize")).toEqual(record);
    expect(await readFile(path.join(f.builtin, "example/index.html"), "utf8")).toBe(
      "<h1>Example</h1>",
    );
  } finally {
    await f.close();
  }
});
it.each([
  "keep",
  "replace",
  "copy",
] as const)("handles the %s update choice without losing saved state", async (choice) => {
  const f = await viewFixture();
  try {
    await f.registry.api("view.customize", { id: "example" }, "customize");
    await f.registry.api(
      "view.setGrants",
      { id: "example", permissions: ["read"], confirmed: true },
      "grant",
    );
    await writeFile(path.join(f.registry.user, "example/index.html"), "<h1>Customized</h1>");
    const saved = { groups: { 1: ["chat"] } };
    await writeViewState(f.registry, "example", saved);
    const manifestPath = path.join(f.builtin, "example/view.json"),
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.version = "2.0.0";
    await writeFile(manifestPath, JSON.stringify(manifest));
    await writeFile(path.join(f.builtin, "example/index.html"), "<h1>New builtin</h1>");
    await f.registry.reload();
    const builtin = await loadView(path.join(f.builtin, "example"));
    expect(f.store.record("view", "example")).toMatchObject({
      source: "user",
      builtinUpdate: { version: "2.0.0", bundleHash: builtin.bundleHash },
    });
    if (choice === "replace") {
      await expect(
        f.registry.api("view.resolveUpdate", { id: "example", choice }, "deny"),
      ).rejects.toThrow("confirmation_required");
      expect(await exists(path.join(f.registry.user, "example"))).toBeTruthy();
    }
    const originalDirectory = await lstat(path.join(f.registry.user, "example"));
    const result = await f.registry.api(
      "view.resolveUpdate",
      { id: "example", choice, ...(choice === "replace" ? { confirmed: true } : {}) },
      "update",
    );
    expect(await readViewState(f.registry, "example")).toEqual(saved);
    if (choice === "keep") {
      expect(await readFile(path.join(f.registry.user, "example/index.html"), "utf8")).toBe(
        "<h1>Customized</h1>",
      );
      expect(result).toMatchObject({ source: "user", basedOn: { bundleHash: builtin.bundleHash } });
      expect(f.store.record("view", "example")?.builtinUpdate).toBeUndefined();
    } else {
      expect(await exists(path.join(f.registry.user, "example"))).toBeUndefined();
      expect(f.store.record("view", "example")).toMatchObject({
        source: "builtin",
        granted: ["read"],
      });
      if (choice === "copy") {
        expect((await lstat(path.join(f.registry.user, "example-custom"))).ino).toBe(
          originalDirectory.ino,
        );
        expect(result).toMatchObject({ id: "example-custom", source: "user", granted: [] });
        expect(
          await readFile(path.join(f.registry.user, "example-custom/index.html"), "utf8"),
        ).toBe("<h1>Customized</h1>");
        expect(await readViewState(f.registry, "example-custom")).toEqual(saved);
        expect((await loadView(path.join(f.registry.user, "example-custom"))).manifest.id).toBe(
          "example-custom",
        );
        expect(f.store.record("view", "example-custom")?.builtinUpdate).toBeUndefined();
      } else
        expect(f.store.snapshot().audit).toContainEqual(
          expect.objectContaining({
            action: "view.resolveUpdate",
            detail: expect.objectContaining({ choice: "replace", confirmed: true }),
          }),
        );
    }
    expect(
      await f.registry.api(
        "view.resolveUpdate",
        { id: "example", choice, ...(choice === "replace" ? { confirmed: true } : {}) },
        "update",
      ),
    ).toEqual(result);
  } finally {
    await f.close();
  }
});

it("avoids an existing custom folder and continues tracking the original builtin after renaming", async () => {
  const f = await viewFixture();
  try {
    await f.registry.api("view.customize", { id: "example" }, "customize");
    await mkdir(path.join(f.registry.user, "example-custom"));
    await writeFile(path.join(f.registry.user, "example-custom/notes.txt"), "Retain this work");
    await writeFile(path.join(f.builtin, "example/index.html"), "<h1>Updated</h1>");
    await f.registry.reload();
    const record = await f.registry.api(
      "view.resolveUpdate",
      { id: "example", choice: "copy" },
      "copy",
    );
    expect(record).toMatchObject({
      id: "example-custom-2",
      granted: [],
      basedOn: { id: "example" },
    });
    expect(await readFile(path.join(f.registry.user, "example-custom/notes.txt"), "utf8")).toBe(
      "Retain this work",
    );
    await writeFile(path.join(f.builtin, "example/index.html"), "<h1>Another update</h1>");
    await f.registry.reload();
    expect(f.store.record("view", "example-custom-2")?.builtinUpdate).toMatchObject({
      bundleHash: (await loadView(path.join(f.builtin, "example"))).bundleHash,
    });
  } finally {
    await f.close();
  }
});
