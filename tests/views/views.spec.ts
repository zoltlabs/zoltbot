import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { expect, test, type WebSocketRoute } from "@playwright/test";
import { viewProtocol } from "../../apps/desktop/src/view-protocol.js";
import { loadView, viewRecord } from "../../packages/daemon/src/views/loader.js";
import type { ZoltClient } from "../../packages/view-api/src/client.js";
import fixture from "../../packages/view-api/src/fixtures/snapshot.json" with { type: "json" };

let origin = "",
  close: () => Promise<void>,
  revoke: () => void;
let seq = 1;
const sockets = new Set<WebSocketRoute>();
let record: ReturnType<typeof viewRecord>,
  snapshot: { entities: Record<string, Record<string, unknown>[]> };
test.beforeAll(async () => {
  const root = process.cwd(),
    bundle = await loadView(path.join(root, "packages/views/command-map"));
  record = viewRecord(bundle, bundle, ["read"]);
  record.reviewed = [...record.requested];
  snapshot = structuredClone(fixture) as { entities: Record<string, Record<string, unknown>[]> };
  snapshot.entities.view = [record];
  const now = new Date().toISOString();
  for (const thread of snapshot.entities.thread ?? []) thread.lastActivityAt = now;
  const first = snapshot.entities.thread?.[0];
  if (first) first.projectId = "space08";
  for (let index = 0; index < 9; index++) {
    const id = `space0${index}`;
    snapshot.entities.project ??= [];
    snapshot.entities.project.push({ id, name: id, roots: [] });
    if (index < 8) {
      snapshot.entities.thread ??= [];
      snapshot.entities.thread.push({
        id,
        agentId: "profile",
        kind: "main",
        title: id,
        archived: false,
        projectId: id,
        createdAt: now,
        lastActivityAt: now,
      });
      snapshot.entities.turn ??= [];
      snapshot.entities.turn.push({
        id: `turn-${id}`,
        threadId: id,
        status: "running",
        startedAt: now,
      });
    }
  }
  let handler: ReturnType<typeof viewProtocol>;
  const requests: string[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const pathname = new URL(request.url ?? "/", origin).pathname;
      if (pathname.startsWith(`/view/${bundle.bundleHash}/`)) {
        requests.push(pathname);
        const result = await handler.handle(
          new Request(
            `zoltbot-view://${bundle.bundleHash}/${pathname.slice(`/view/${bundle.bundleHash}/`.length)}`,
          ),
        );
        const headers = Object.fromEntries(result.headers);
        headers["content-security-policy"] = (headers["content-security-policy"] ?? "").replaceAll(
          `zoltbot-view://${bundle.bundleHash}`,
          `${origin}/view/${bundle.bundleHash}/`,
        );
        response.writeHead(result.status, headers);
        response.end(Buffer.from(await result.arrayBuffer()));
        return;
      }
      const relative = pathname === "/" ? "index.html" : pathname.slice(1),
        target = path.resolve(root, "dist/ui", relative);
      if (!target.startsWith(path.resolve(root, "dist/ui") + path.sep)) {
        response.writeHead(404);
        response.end();
        return;
      }
      let bytes = await readFile(target);
      if (relative === "index.html")
        bytes = Buffer.from(
          bytes
            .toString()
            .replace(
              "frame-src zoltbot-artifact: zoltbot-view:",
              `frame-src zoltbot-artifact: zoltbot-view: ${origin}`,
            ),
        );
      response.writeHead(200, {
        "Content-Type": relative.endsWith("html")
          ? "text/html"
          : relative.endsWith("js")
            ? "text/javascript"
            : relative.endsWith("css")
              ? "text/css"
              : relative.endsWith("svg")
                ? "image/svg+xml"
                : "application/octet-stream",
      });
      response.end(bytes);
    })().catch(() => {
      response.writeHead(404);
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw Error("fixture");
  origin = `http://127.0.0.1:${address.port}`;
  handler = viewProtocol({
    origin,
    client: () => Buffer.from(requireClient),
    asset: async (kind, _hash, hash) =>
      kind === "manifest"
        ? Buffer.from(JSON.stringify({ manifestBytes: bundle.manifestBytes, files: bundle.files }))
        : readFile(
            path.join(
              bundle.directory,
              bundle.files.find((file) => file.hash === hash)?.path ?? "missing",
            ),
          ),
  });
  await handler.prepare(bundle.bundleHash);
  revoke = () => {
    record.granted = [];
    for (const socket of sockets)
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "event",
          params: {
            seq: ++seq,
            eventId: `view-change-${seq}`,
            aggregateType: "view",
            aggregateId: record.id,
            type: "view.updated",
            occurredAt: now,
            payload: record,
          },
        }),
      );
  };
  close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  test.info().annotations.push({
    type: "isolation",
    description:
      "The harness rewrites scheme URLs to loopback paths in CSP only for Chromium. Electron scheme registration and site isolation remain unverified.",
  });
});
const requireClient = await readFile(
  new URL("../../packages/view-api/client/zolt.js", import.meta.url),
  "utf8",
);
test.afterAll(async () => close?.());
test("renders real mappings, edge alerts and chat navigation without network access, and unloads on read revocation", async ({
  page,
}) => {
  await page.routeWebSocket("**/*", (socket) => {
    sockets.add(socket);
    socket.onClose(() => sockets.delete(socket));
    socket.onMessage((bytes) => {
      const message = JSON.parse(bytes.toString());
      if (message.method === "view.setGrants") {
        record.granted = message.params.permissions;
        record.reviewed = [...record.requested];
        socket.send(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "event",
            params: {
              seq: ++seq,
              eventId: `grant-${seq}`,
              aggregateType: "view",
              aggregateId: record.id,
              type: "view.updated",
              occurredAt: new Date().toISOString(),
              payload: record,
            },
          }),
        );
      }
      if (message.method === "view.call") actionCalls.push(message.params);
      const result =
        message.method === "snapshot.get"
          ? { seq, entities: snapshot.entities, counters: {} }
          : message.method === "events.subscribe"
            ? { seq, resync: false, events: [] }
            : message.method === "view.reload"
              ? [record]
              : message.method.endsWith(".list") || message.method.endsWith(".history")
                ? { items: [] }
                : { ok: true };
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
  });
  const actionCalls: Record<string, unknown>[] = [];
  const external: string[] = [];
  page.on("request", (request) => {
    if (!request.url().startsWith(origin) && !request.url().startsWith("data:"))
      external.push(request.url());
  });
  await page.addInitScript(
    ({ origin }) => {
      if (window.top !== window) return;
      window.zoltDesktop = {
        connection: async () => ({
          url: origin.replace("http:", "ws:"),
          token: "synthetic-owner-token",
        }),
        onConnectionChanged: () => () => {},
        prepareView: async (hash: string) => ({ url: `${origin}/view/${hash}/index.html` }),
      };
    },
    { origin },
  );
  record.granted = [];
  record.reviewed = [];
  await page.goto(`${origin}/#view/command-map`);
  const dialog = page.getByRole("dialog", { name: "Permissions for Command map" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("checkbox").nth(0)).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("checkbox").nth(1)).toBeFocused();
  await expect(dialog.getByRole("checkbox")).toHaveCount(3);
  await expect(dialog.getByRole("checkbox").nth(0)).toBeChecked();
  await expect(dialog.getByRole("checkbox").nth(1)).not.toBeChecked();
  await expect(dialog.getByRole("checkbox").nth(2)).not.toBeChecked();
  await dialog.getByRole("button", { name: "Save permissions" }).focus();
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  expect(record.granted).toEqual(["read"]);
  const frame = page.frameLocator('iframe[title="Command map"]');
  await expect(frame.getByText("Needs input — Needs you", { exact: true })).toBeVisible();
  await expect(frame.getByText("Review — Done", { exact: true })).toBeVisible();
  await expect(frame.locator(".edge-alert:not([hidden])").first()).toBeVisible();
  await frame.locator(".edge-alert:not([hidden])").first().click();
  await expect(frame.locator('.unit[data-chat="needs"]')).toBeVisible();
  expect(external).toEqual([]);
  expect(await frame.locator("body").evaluate(() => typeof window.zoltDesktop)).toBe("undefined");
  await expect(frame.locator("#error")).toHaveText("");
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  await expect(frame.getByText("Needs input — Needs you", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).last().click();
  await page.getByRole("button", { name: "Edit permissions" }).click();
  const edit = page.getByRole("dialog", { name: "Permissions for Command map" });
  await edit.getByRole("checkbox").nth(2).check();
  await edit.getByRole("button", { name: "Save permissions" }).click();
  await page.getByRole("button", { name: "Open view", exact: true }).click();
  await expect(frame.getByText("Needs input — Needs you", { exact: true })).toBeVisible();
  const answer = async () =>
    frame.locator("body").evaluate(() => {
      const client = (window as unknown as { zolt: ZoltClient }).zolt;
      void client.requests
        .answer({ requestId: "request", version: 2, choiceId: "allow_session" })
        .catch(() => {});
    });
  await answer();
  const confirmation = page.getByRole("dialog", { name: "Run tests?" });
  await expect(confirmation).toBeVisible();
  await expect(confirmation.getByText("pnpm test", { exact: true })).toBeVisible();
  expect(actionCalls).toEqual([]);
  await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(actionCalls).toEqual([]);
  await answer();
  await confirmation.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect.poll(() => actionCalls.length).toBe(1);
  expect(actionCalls[0]).toMatchObject({
    id: "command-map",
    method: "requests.answer",
    confirmed: true,
  });
  const darkBackground = await frame
    .locator("body")
    .evaluate((body) => getComputedStyle(body).backgroundColor);
  const contrast = () =>
    frame.locator("body").evaluate((body) => {
      const style = getComputedStyle(body);
      const luminance = (value: string) => {
        const channels = (value.match(/[0-9.]+/g) ?? []).slice(0, 3).map((part) => {
          const c = Number(part) / 255;
          return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
        return (
          (channels[0] ?? 0) * 0.2126 + (channels[1] ?? 0) * 0.7152 + (channels[2] ?? 0) * 0.0722
        );
      };
      const a = luminance(style.color),
        b = luminance(style.backgroundColor);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    });
  expect(await contrast()).toBeGreaterThanOrEqual(4.5);
  await page.getByRole("button", { name: "Use light theme", exact: true }).click();
  await expect
    .poll(() => frame.locator("body").evaluate((body) => getComputedStyle(body).backgroundColor))
    .not.toBe(darkBackground);
  expect(await contrast()).toBeGreaterThanOrEqual(4.5);
  await page.screenshot({ path: "output/playwright/views/command-map-light.png" });
  await page.setViewportSize({ width: 320, height: 900 });
  await frame
    .locator("html")
    .evaluate((root) => (root as HTMLElement).style.setProperty("--zb-font-scale", "2"));
  expect(
    await frame.locator(".panel").evaluate((panel) => panel.scrollWidth <= panel.clientWidth),
  ).toBe(true);
  await page.screenshot({ path: "output/playwright/views/command-map-narrow.png" });
  await page.setViewportSize({ width: 1280, height: 900 });

  await page.screenshot({ path: "output/playwright/views/command-map-dark.png" });
  const blocked = await frame.locator("body").evaluate(async () => {
    try {
      await fetch("https://example.invalid/view-probe");
      return false;
    } catch {
      return true;
    }
  });
  expect(blocked).toBe(true);
  await frame.getByRole("button", { name: "Open chat: Needs input", exact: true }).click();
  await expect(page).toHaveURL(/#chat\/needs$/);
  await page.goto(`${origin}/#view/command-map`);
  await expect(page.locator("iframe")).toHaveCount(1);
  revoke();
  await expect(page.locator("iframe")).toHaveCount(0);
  await expect(
    page.getByText(
      "This view needs permission to read your chats. Open Settings to manage its permissions.",
    ),
  ).toBeVisible();
});
