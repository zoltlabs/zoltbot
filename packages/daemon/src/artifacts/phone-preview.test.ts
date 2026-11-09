import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { phonePreview } from "./phone-preview.js";
import { artifactFixture } from "./test-fixture.js";

it("refuses held, missing and foreign versions before starting a browser", async () => {
  const f = await artifactFixture();
  try {
    const a = await f.save("<h1>Original</h1>");
    const b = await f.save("<h1>Other</h1>", "other");
    await expect(phonePreview(f.store, a.artifactId, b.versionId)).rejects.toThrow("scope");
    await expect(phonePreview(f.store, a.artifactId, "missing")).rejects.toThrow("not_found");
    for (const changes of [{ held: true }, { held: false, metadataOnly: true }]) {
      f.change({ type: "update", kind: "artifactVersion", id: a.versionId, changes });
      await expect(phonePreview(f.store, a.artifactId, a.versionId)).rejects.toThrow("unavailable");
    }
  } finally {
    await f.close();
  }
});
it("renders the requested immutable bundle headlessly and blocks external requests", async () => {
  const f = await artifactFixture();
  const require = createRequire(fileURLToPath(import.meta.resolve("@playwright/cli/package.json")));
  const { chromium } = require("playwright-core") as typeof import("playwright-core");
  const close = vi.fn();
  const fulfill = vi.fn();
  const abort = vi.fn();
  const goto = vi.fn();
  const screenshot = vi.fn(async () => Buffer.from("preview"));
  const route = vi.fn(async (_pattern, handler) => {
    for (const url of [
      "https://artifact.invalid/index.html",
      "https://example.invalid/private",
      "file:///etc/passwd",
      "https://artifact.invalid/missing",
    ]) {
      await handler({ request: () => ({ url: () => url, method: () => "GET" }), fulfill, abort });
    }
  });
  const launch = vi.spyOn(chromium, "launch").mockResolvedValue({
    newContext: async () => ({
      route,
      newPage: async () => ({
        setDefaultTimeout() {},
        async emulateMedia() {},
        goto,
        screenshot,
      }),
    }),
    close,
  } as unknown as Awaited<ReturnType<typeof chromium.launch>>);
  try {
    const old = await f.save("<h1>Original</h1>");
    await f.save("<h1>Current</h1>");
    expect(await phonePreview(f.store, old.artifactId, old.versionId)).toMatchObject({
      kind: "image",
      uri: "data:image/jpeg;base64,cHJldmlldw==",
    });
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({ headless: true, chromiumSandbox: true }),
    );
    expect(fulfill.mock.calls[0]?.[0].body.toString()).toContain("Original");
    expect(fulfill.mock.calls[0]?.[0].headers["Content-Security-Policy"]).toContain(
      "connect-src https://artifact.invalid",
    );
    expect(abort).toHaveBeenCalledTimes(3);
    expect(close).toHaveBeenCalledOnce();
    screenshot.mockRejectedValueOnce(Error("render_failed"));
    await expect(phonePreview(f.store, old.artifactId, old.versionId)).rejects.toThrow(
      "render_failed",
    );
    expect(close).toHaveBeenCalledTimes(2);
  } finally {
    launch.mockRestore();
    await f.close();
  }
});
