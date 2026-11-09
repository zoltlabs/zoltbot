import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { artifactProtocol } from "./artifact-protocol.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
it("activates only verified manifests, serves allowlisted verified bytes, and keeps SVG and Markdown scriptless", async () => {
  const content = {
    "index.html": "<h1>Hello</h1>",
    "evil.svg": "<svg><script>bad()</script></svg>",
    "readme.md": "<script>bad()</script>",
  };
  const manifest = {
    version: 1,
    entry: "index.html",
    files: Object.entries(content).map(([path, bytes]) => ({
      path,
      bytes: Buffer.byteLength(bytes),
      hash: hash(bytes),
      mime: path.endsWith("svg")
        ? "image/svg+xml"
        : path.endsWith("md")
          ? "text/markdown"
          : "text/html",
    })),
    screens: [],
  };
  const text = JSON.stringify(manifest),
    id = hash(text);
  let corrupt = false;
  const handler = artifactProtocol({
    origin: "http://127.0.0.1:5173",
    asset: async (kind, requested) =>
      Buffer.from(
        kind === "manifest"
          ? text
          : corrupt
            ? "corrupt"
            : (Object.values(content).find((value) => hash(value) === requested) ?? ""),
      ),
  });
  const url = (p: string) => new Request(`zoltbot-artifact://${id}/${p}`);
  expect((await handler.handle(url("index.html"))).status).toBe(404);
  await handler.prepare(id);
  const response = await handler.handle(url("index.html"));
  expect(await response.text()).toBe(content["index.html"]);
  expect(response.headers.get("Content-Security-Policy")).toContain("sandbox allow-scripts");
  expect(response.headers.get("Access-Control-Allow-Origin")).toBe("null");
  for (const p of ["evil.svg", "readme.md"]) {
    const result = await handler.handle(url(p));
    expect(result.headers.get("Content-Security-Policy")).toContain("script-src 'none'");
    expect(result.headers.get("Content-Security-Policy")).not.toContain("sandbox allow-scripts");
  }
  expect(await (await handler.handle(url("readme.md"))).text()).not.toContain("bad()");
  for (const p of ["unknown.html", "%2e%2e%2foutside", "index.html?probe=1", "%252e%252e/outside"])
    expect((await handler.handle(url(p))).status).toBe(404);
  corrupt = true;
  expect((await handler.handle(url("index.html"))).status).toBe(404);
  await expect(handler.prepare("0".repeat(64))).rejects.toThrow("corrupt");
});
