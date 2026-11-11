import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { frameRequestAllowed } from "./frame-isolation.js";
import { viewCsp, viewProtocol } from "./view-protocol.js";

const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
function fixture() {
  const manifestBytes = JSON.stringify({
    manifest: 1,
    id: "example",
    name: "Example",
    version: "1.0.0",
    api: 1,
    entry: "index.html",
    slots: ["page"],
    permissions: ["read"],
  });
  const content = {
    "view.json": manifestBytes,
    "index.html": "<h1>Example</h1>",
    "data.json": "{}",
  };
  const files = Object.entries(content).map(([path, text]) => ({
    path,
    hash: hash(text),
    bytes: Buffer.byteLength(text),
    mime: path.endsWith("html") ? "text/html" : "application/json",
  }));
  const bundleHash = hash(
    manifestBytes +
      files
        .map((file) => `${file.path}:${file.hash}`)
        .sort()
        .join("\n"),
  );
  return { content, manifestBytes, files, bundleHash };
}
it("serves only verified, prepared bundles with isolated response headers", async () => {
  const value = fixture();
  let corrupt = false;
  const handler = viewProtocol({
    origin: "zoltbot://desktop",
    client: () => Buffer.from("/* trusted client */"),
    asset: async (kind, _bundle, requested) =>
      Buffer.from(
        kind === "manifest"
          ? JSON.stringify({ manifestBytes: value.manifestBytes, files: value.files })
          : corrupt
            ? "bad"
            : (Object.values(value.content).find((text) => hash(text) === requested) ?? ""),
      ),
  });
  const request = (name: string) => new Request(`zoltbot-view://${value.bundleHash}/${name}`);
  expect((await handler.handle(request("index.html"))).status).toBe(404);
  expect(await handler.prepare(value.bundleHash)).toEqual({
    url: `zoltbot-view://${value.bundleHash}/index.html`,
  });
  const response = await handler.handle(request("index.html"));
  expect(await response.text()).toBe(value.content["index.html"]);
  expect(response.headers.get("Content-Security-Policy")).toBe(
    viewCsp("zoltbot://desktop", value.bundleHash),
  );
  for (const [name, expected] of Object.entries({
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "Access-Control-Allow-Origin": "null",
  }))
    expect(response.headers.get(name)).toBe(expected);
  expect(await (await handler.handle(request("_host/v1/zolt.js"))).text()).toContain(
    "trusted client",
  );
  for (const name of [
    "outside.html",
    "%2e%2e%2foutside",
    "%252e%252e/outside",
    "data.json?probe=1",
    "a%5cb",
    "_host/v2/zolt.js",
  ])
    expect((await handler.handle(request(name))).status).toBe(404);
  expect(
    (await handler.handle(new Request(`zoltbot-view://${"b".repeat(64)}/index.html`))).status,
  ).toBe(404);
  corrupt = true;
  expect((await handler.handle(request("index.html"))).status).toBe(404);
  await expect(handler.prepare("0".repeat(64))).rejects.toThrow("corrupt");
});
it("rejects tampered manifests, file sizes and paths", async () => {
  for (const change of ["hash", "size", "path", "collision", "entry", "reserved"]) {
    const value = fixture();
    const file = value.files[1];
    if (!file) throw Error("fixture");
    if (change === "hash") file.hash = "f".repeat(64);
    if (change === "size") file.bytes = 25 * 1024 * 1024 + 1;
    if (change === "path") file.path = "../index.html";
    if (change === "collision") value.files.push({ ...file, path: file.path.toUpperCase() });
    if (change === "entry") file.path = "other.html";
    if (change === "reserved") file.path = "_host/v1/zolt.js";
    const handler = viewProtocol({
      origin: "zoltbot://desktop",
      asset: async () => Buffer.from(JSON.stringify(value)),
    });
    await expect(handler.prepare(value.bundleHash)).rejects.toThrow();
  }
});
it("blocks cross-view, cross-scheme and network requests and main-frame view URLs", () => {
  const view = `zoltbot-view://${"a".repeat(64)}/index.html`,
    other = `zoltbot-view://${"b".repeat(64)}/map.js`,
    artifact = `zoltbot-artifact://${"a".repeat(64)}/index.html`;
  expect(frameRequestAllowed("zoltbot://desktop/", view, "subFrame")).toBe(true);
  expect(frameRequestAllowed(view, view.replace("index.html", "map.js"), "script")).toBe(true);
  for (const target of [
    other,
    artifact,
    "https://example.invalid/",
    "http://127.0.0.1:1234/",
    "file:///example",
    "zoltbot://desktop/",
  ])
    for (const type of ["script", "xhr", "subFrame"])
      expect(frameRequestAllowed(view, target, type)).toBe(false);
  expect(frameRequestAllowed("zoltbot://desktop/", view, "mainFrame")).toBe(false);
  expect(frameRequestAllowed(artifact, view, "subFrame")).toBe(false);
  expect(frameRequestAllowed(view, "blob:null/example", "image")).toBe(true);
  const csp = viewCsp("zoltbot://desktop", "a".repeat(64));
  expect(csp).not.toContain("allow-same-origin");
  expect(csp).not.toContain("wasm-unsafe-eval");
  expect(csp).toContain("worker-src zoltbot-view:");
  expect(csp).toContain("frame-src 'none'");
});
