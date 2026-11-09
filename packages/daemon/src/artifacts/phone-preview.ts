import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Store } from "@zoltbot/store";
import { artifactKitAsset } from "../../../artifact-kit/src/index.js";
import { blobBytes } from "./intake.js";
import { artifactDirectory, artifactRecord, artifactVersion, versionDetail } from "./model.js";

/** Phone previews are bounded raster images, never executable bundles or local file URLs. */
export async function phonePreview(store: Store, id: string, versionId: string) {
  const artifact = artifactRecord(store, id);
  const version = artifactVersion(store, versionId);
  if (version.artifactId !== artifact.id || artifact.state !== "active")
    throw Error("artifact_version_scope_denied");
  if (
    version.held ||
    version.metadataOnly ||
    (artifact.currentVersionId === versionId && artifact.repositoryState === "held_secret")
  )
    throw Error("artifact_preview_unavailable");
  const { manifest } = versionDetail(store, version.id);
  const entry = manifest.files.find((f) => f.path === manifest.entry);
  if (!entry) throw Error("artifact_preview_unavailable");
  // Native text is readable with Dynamic Type and screen readers.
  if (["text/markdown", "text/plain"].includes(entry.mime)) {
    if (entry.bytes > 64 * 1024) throw Error("artifact_preview_too_large");
    return {
      kind: "text",
      text: (await blobBytes(artifactDirectory(store), entry.hash)).toString("utf8"),
    };
  }
  if (!["text/html", "image/png", "image/jpeg", "image/webp", "image/svg+xml"].includes(entry.mime))
    throw Error("artifact_preview_unavailable");
  const require = createRequire(fileURLToPath(import.meta.resolve("@playwright/cli/package.json")));
  const { chromium } = require("playwright-core") as typeof import("playwright-core");
  const installed = chromium.executablePath().match(/(chromium-[0-9]+[/\\].*)$/)?.[1];
  const local = installed
    ? path.join(path.dirname(store.database.name), "browser", "browsers", installed)
    : "";
  const browser = await chromium.launch({
    headless: true,
    chromiumSandbox: true,
    ...(local && existsSync(local) ? { executablePath: local } : {}),
  });
  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 780 },
      deviceScaleFactor: 1,
      serviceWorkers: "block",
      acceptDownloads: false,
    });
    await context.route("**/*", async (route) => {
      try {
        const url = new URL(route.request().url());
        if (
          url.origin !== "https://artifact.invalid" ||
          route.request().method() !== "GET" ||
          url.search
        )
          return await route.abort();
        const relative = decodeURIComponent(url.pathname.slice(1));
        const kit =
          manifest.kit === "v1" && relative.startsWith("kit/v1/")
            ? artifactKitAsset("", relative.slice(7))
            : undefined;
        if (kit) return await route.fulfill({ body: kit.bytes, contentType: kit.mime });
        const file = manifest.files.find((f) => f.path === relative);
        if (!file || file.bytes > 4 * 1024 * 1024) return await route.abort();
        await route.fulfill({
          body: await blobBytes(artifactDirectory(store), file.hash),
          contentType: file.mime,
          headers: {
            "Content-Security-Policy":
              "default-src 'none'; sandbox allow-scripts; script-src 'unsafe-inline' https://artifact.invalid; style-src 'unsafe-inline' https://artifact.invalid; img-src https://artifact.invalid data:; font-src https://artifact.invalid; connect-src https://artifact.invalid; form-action 'none'; base-uri 'none'; frame-src 'none'; worker-src 'none'",
            "X-Content-Type-Options": "nosniff",
          },
        });
      } catch {
        await route.abort();
      }
    });
    const page = await context.newPage();
    await page.emulateMedia({ reducedMotion: "reduce" });
    page.setDefaultTimeout(10000);
    const url = `https://artifact.invalid/${manifest.entry.split("/").map(encodeURIComponent).join("/")}`;
    await page.goto(url, { waitUntil: "load", timeout: 10000 });
    // A viewport preview stays small enough for the encrypted phone link. Full documents use text.
    const bytes = await page.screenshot({
      type: "jpeg",
      quality: 70,
      animations: "disabled",
      timeout: 10000,
    });
    const current = artifactVersion(store, versionId);
    if (current.held || current.metadataOnly || artifactRecord(store, id).state !== "active")
      throw Error("artifact_preview_unavailable");
    if (bytes.length > 256 * 1024) throw Error("artifact_preview_too_large");
    return {
      kind: "image",
      uri: `data:image/jpeg;base64,${bytes.toString("base64")}`,
      width: 390,
      height: 780,
    };
  } finally {
    await browser.close();
  }
}

// Share the renderer across callers by serializing work, without retaining source or image caches.
let tail: Promise<unknown> = Promise.resolve();
let pending = 0;
export function queuedPhonePreview(store: Store, id: string, versionId: string) {
  if (pending >= 4) return Promise.reject(Error("artifact_preview_busy"));
  pending++;
  const next = tail
    .then(() => phonePreview(store, id, versionId))
    .finally(() => {
      pending--;
    });
  tail = next.catch(() => undefined);
  return next;
}
