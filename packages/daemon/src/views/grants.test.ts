import { writeFile } from "node:fs/promises";
import path from "node:path";
import { macOnlyMethods } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { viewFixture } from "./test-fixture.js";

it("starts without grants, requires confirmed owner consent, audits changes and persists reviews", async () => {
  const f = await viewFixture();
  try {
    expect(f.store.record("view", "example")?.granted).toEqual([]);
    await expect(
      f.registry.api(
        "view.setGrants",
        { id: "example", permissions: ["read"], confirmed: false },
        "deny",
      ),
    ).rejects.toThrow("confirmation_required");
    await f.registry.api(
      "view.setGrants",
      { id: "example", permissions: ["read"], confirmed: true },
      "allow",
    );
    await f.registry.reload();
    expect(f.store.record("view", "example")).toMatchObject({
      granted: ["read"],
      reviewed: ["read", "act", "approve"],
    });
    expect(f.store.snapshot().audit).toContainEqual(
      expect.objectContaining({
        action: "view.setGrants",
        target: "example",
        detail: { permissions: ["read"], confirmed: true },
      }),
    );
    await expect(
      f.registry.api(
        "view.setGrants",
        { id: "example", permissions: ["act"], confirmed: true },
        "allow",
      ),
    ).rejects.toThrow("receipt_conflict");
    expect(macOnlyMethods).toContain("view.setGrants");
  } finally {
    await f.close();
  }
});
it("never reads grants or review state from the view folder", async () => {
  const f = await viewFixture();
  try {
    await writeFile(
      path.join(f.builtin, "example", "view.json"),
      JSON.stringify({
        manifest: 1,
        id: "example",
        name: "Example",
        version: "1.0.0",
        api: 1,
        entry: "index.html",
        slots: ["page"],
        permissions: ["read"],
        granted: ["read", "act"],
        reviewed: ["read"],
      }),
    );
    await f.registry.reload();
    expect(f.store.record("view", "example")).toMatchObject({ granted: [], reviewed: [] });
  } finally {
    await f.close();
  }
});
