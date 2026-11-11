import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { viewFixture } from "./test-fixture.js";

it("debounces edits in one user watch, publishes a fresh bundle and stops cleanly", async () => {
  const f = await viewFixture();
  try {
    await f.registry.api("view.customize", { id: "example" }, "customize");
    await f.registry.start([]);
    const reload = vi.spyOn(f.registry, "reload");
    const old = f.store.record("view", "example")?.bundleHash;
    await writeFile(path.join(f.registry.user, "example/index.html"), "<h1>First edit</h1>");
    await writeFile(path.join(f.registry.user, "example/index.html"), "<h1>Second edit</h1>");
    await vi.waitFor(() => expect(f.store.record("view", "example")?.bundleHash).not.toBe(old), {
      timeout: 3000,
    });
    expect(reload).toHaveBeenCalledTimes(1);
    const changed = f.store.record("view", "example")?.bundleHash;
    await writeFile(
      path.join(f.builtin, "example/index.html"),
      "<h1>Builtin change is not watched</h1>",
    );
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(f.store.record("view", "example")?.bundleHash).toBe(changed);
    expect(reload).toHaveBeenCalledTimes(1);
    await f.registry.close();
    await writeFile(path.join(f.registry.user, "example/index.html"), "<h1>After close</h1>");
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(reload).toHaveBeenCalledTimes(1);
  } finally {
    await f.close();
  }
});
