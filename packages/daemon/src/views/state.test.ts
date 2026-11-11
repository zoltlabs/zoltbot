import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { stateDirectory, viewStateLimit } from "./state.js";
import { viewFixture } from "./test-fixture.js";

it("scopes JSON state outside bundles, preserves it across reload and leaves grants in the database", async () => {
  const f = await viewFixture();
  try {
    for (const method of ["view.state.get", "view.state.set"])
      await expect(f.registry.api(method, { id: "example", value: {} })).rejects.toThrow(
        "not_granted",
      );
    await f.registry.api(
      "view.setGrants",
      { id: "example", permissions: ["read"], confirmed: true },
      "grant",
    );
    expect(await f.registry.api("view.state.get", { id: "example" })).toEqual({ value: null });
    const value = {
      groups: { 1: ["chat"] },
      layout: { region: { x: 12, z: 4 } },
      granted: ["act"],
    };
    const hash = f.store.record("view", "example")?.bundleHash;
    await f.registry.api("view.state.set", { id: "example", value });
    await f.registry.reload();
    expect(await f.registry.api("view.state.get", { id: "example" })).toEqual({ value });
    expect(f.store.record("view", "example")).toMatchObject({
      bundleHash: hash,
      granted: ["read"],
    });
    expect(
      JSON.parse(await readFile(path.join(stateDirectory(f.registry), "example.json"), "utf8")),
    ).toEqual(value);
    await expect(f.registry.api("view.state.get", { id: "other" })).rejects.toThrow("not_granted");
    await expect(
      f.registry.api("view.state.set", { id: "example", value: "x".repeat(viewStateLimit) }),
    ).rejects.toThrow("too_large");
    expect(await f.registry.api("view.state.get", { id: "example" })).toEqual({ value });
  } finally {
    await f.close();
  }
});
it("rejects symlink state files and ancestors without changing their targets", async () => {
  const f = await viewFixture();
  try {
    await f.registry.api(
      "view.setGrants",
      { id: "example", permissions: ["read"], confirmed: true },
      "grant",
    );
    await mkdir(stateDirectory(f.registry));
    const outside = path.join(f.root, "outside.json");
    await writeFile(outside, "{}");
    await symlink(outside, path.join(stateDirectory(f.registry), "example.json"));
    await expect(f.registry.api("view.state.get", { id: "example" })).rejects.toThrow();
    await expect(
      f.registry.api("view.state.set", { id: "example", value: { changed: true } }),
    ).rejects.toThrow();
    expect(await readFile(outside, "utf8")).toBe("{}");
  } finally {
    await f.close();
  }
});
it("rejects a symlink at the state directory", async () => {
  const f = await viewFixture();
  try {
    await f.registry.api(
      "view.setGrants",
      { id: "example", permissions: ["read"], confirmed: true },
      "grant",
    );
    const outside = path.join(f.root, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "example.json"), "{}");
    await symlink(outside, stateDirectory(f.registry));
    await expect(f.registry.api("view.state.get", { id: "example" })).rejects.toThrow(
      "directory_denied",
    );
    await expect(f.registry.api("view.state.set", { id: "example", value: {} })).rejects.toThrow(
      "directory_denied",
    );
    expect(await readFile(path.join(outside, "example.json"), "utf8")).toBe("{}");
  } finally {
    await f.close();
  }
});
