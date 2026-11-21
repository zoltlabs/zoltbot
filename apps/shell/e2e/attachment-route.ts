// Shared by the C16–C18 file specs: serves openbot-attachment:// in headless Chromium.
import type { Page, Route } from "@playwright/test";
import { attachmentId, attachmentResponse } from "../src/main/attachment-protocol";
import type { ZoltService } from "../src/zolt/zolt-service";

const FETCHED = "http://shell.test/__attachment/";

/**
 * Serves openbot-attachment:// the way Electron main does, from the same handler. Electron
 * registers the scheme for fetch and frames; headless Chromium does not, so the page reaches it
 * through an http path instead.
 */
export async function serveAttachments(page: Page, service: ZoltService) {
  // Added after the shell opens, so this route wins over the shell's own for its path.
  await page.evaluate((prefix) => {
    const scheme = "openbot-attachment://";
    const mapped = (url: string) =>
      url.startsWith(scheme) ? prefix + url.slice(scheme.length) : url;
    const fetch = window.fetch.bind(window);
    window.fetch = (input, init) => fetch(typeof input === "string" ? mapped(input) : input, init);
    const rewrite = (element: Element) => {
      const src = element.getAttribute("src");
      if (src?.startsWith(scheme)) element.setAttribute("src", mapped(src));
    };
    document.querySelectorAll("[src]").forEach(rewrite);
    new MutationObserver((changes) => {
      for (const change of changes) {
        if (change.type === "attributes") rewrite(change.target as Element);
        for (const node of change.addedNodes)
          if (node instanceof Element) [node, ...node.querySelectorAll("[src]")].forEach(rewrite);
      }
    }).observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["src"],
    });
  }, FETCHED);
  const serve = async (route: Route) => {
    const request = route.request();
    const url = request.url().replace(FETCHED, "openbot-attachment://");
    const id = attachmentId(url);
    const response = await attachmentResponse(
      new Request(url, { headers: await request.allHeaders() }),
      id ? service.attachmentSource(id) : undefined,
    );
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: Buffer.from(await response.arrayBuffer()),
    });
  };
  await page.route("openbot-attachment://**", serve);
  await page.route(`${FETCHED}**`, serve);
}
