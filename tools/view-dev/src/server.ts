import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { safeFile } from "../../../packages/daemon/src/artifacts/intake.js";
import { loadView, viewHash } from "../../../packages/daemon/src/views/loader.js";

const resource = (relative: string) =>
  fileURLToPath(new URL(`../../../${relative}`, import.meta.url));
const csp =
  "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; connect-src 'self'; form-action 'none'; base-uri 'none'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'";
export async function serveView(directory: string) {
  let bundle = await loadView(path.resolve(directory));
  let origin = "";
  const server = createServer((request, response) => {
    void (async () => {
      if (!origin || request.headers.host !== new URL(origin).host)
        throw Error("invalid_view_dev_host");
      if (request.method !== "GET") throw Error("GET required");
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.search) throw Error("Query strings are not supported in view paths");
      const name = decodeURIComponent(url.pathname.slice(1));
      let bytes: Uint8Array, mime: string;
      if (name === "_host/v1/zolt.js") {
        bytes = await readFile(resource("packages/view-api/client/zolt.js"));
        mime = "text/javascript";
      } else if (name === "_host/v1/mock.js") {
        bytes = Buffer.from(
          `window.zoltMockView=${JSON.stringify({ id: bundle.manifest.id, name: bundle.manifest.name, version: bundle.manifest.version })};window.zoltMockPermissions=${JSON.stringify(bundle.manifest.permissions)};\n${await readFile(resource("packages/view-api/mock/data.js"), "utf8")}\n${await readFile(resource("packages/view-api/mock/mock.js"), "utf8")}`,
        );
        mime = "text/javascript";
      } else if (name === "_host/v1/tokens.css") {
        bytes = Buffer.from(
          `${await readFile(resource("packages/tokens/tokens.css"), "utf8")}\n${await readFile(resource("packages/tokens/desktop.css"), "utf8")}`,
        );
        mime = "text/css";
      } else {
        if (!name || name === bundle.manifest.entry)
          bundle = await loadView(path.resolve(directory));
        const file = bundle.files.find((file) => file.path === (name || bundle.manifest.entry));
        if (!file) throw Error("File is not in the checked view bundle");
        bytes = await safeFile(bundle.directory, file.path);
        if (viewHash(bytes) !== file.hash) throw Error("File changed. Reload the page.");
        mime = file.mime;
      }
      response.writeHead(200, {
        "Content-Type": mime,
        "Content-Security-Policy": csp,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      });
      response.end(bytes);
    })().catch(() => {
      response.writeHead(404, {
        "Content-Type": "text/plain",
        "Cache-Control": "no-store",
        "Content-Security-Policy": csp,
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      });
      response.end("View file unavailable. Check the folder and reload.");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw Error("invalid_view_dev_address");
  origin = `http://127.0.0.1:${address.port}`;
  return {
    url: `${origin}/${bundle.manifest.entry.split("/").map(encodeURIComponent).join("/")}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
