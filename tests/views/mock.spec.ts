import { access } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { parse } from "../../packages/protocol/src/index.js";
import type { ZoltClient } from "../../packages/view-api/src/client.js";
import { type Topic, topicSchemas } from "../../packages/view-api/src/topics.js";
import { serveView } from "../../tools/view-dev/src/server.js";

test("runs the client and command map with sample data and calls without any host", async ({
  page,
}) => {
  const server = await serveView("packages/views/command-map");
  try {
    const origin = new URL(server.url).origin,
      external: string[] = [];
    page.on("request", (request) => {
      if (!request.url().startsWith(origin)) external.push(request.url());
    });
    await page.clock.install();
    await page.goto(server.url);
    const facts = await page.evaluate(() => (window as unknown as { zolt: ZoltClient }).zolt.ready);
    expect(facts).toMatchObject({
      mock: true,
      api: 1,
      view: { id: "command-map" },
      granted: ["read", "act", "approve"],
    });
    await expect(page.getByText("Sample data", { exact: true })).toBeVisible();
    await expect(page.getByText("Check the result — Needs you", { exact: true })).toBeVisible();
    async function topic(name: Topic) {
      return page.evaluate(
        (name) =>
          new Promise<unknown>((resolve) => {
            const client = (window as unknown as { zolt: ZoltClient }).zolt;
            const off = client.subscribe([name], (_topic, value) => {
              off();
              resolve(value);
            });
          }),
        name,
      );
    }
    for (const name of ["chats", "requests", "workspaces", "usage", "checks"] as const)
      parse(topicSchemas[name], await topic(name));
    const initial = parse(topicSchemas.usage, await topic("usage"));
    const saved = await page.evaluate(async () => {
      const client = (window as unknown as { zolt: ZoltClient }).zolt;
      await client.storage.set({ groups: { 1: ["demo-build"] } });
      return client.storage.get();
    });
    expect(saved).toEqual({ groups: { 1: ["demo-build"] } });
    const sent = await page.evaluate(() =>
      (window as unknown as { zolt: ZoltClient }).zolt.chats.send({
        chatIds: ["demo-notes"],
        text: "Check the page",
      }),
    );
    expect(sent).toEqual([{ chatId: "demo-notes", result: "started" }]);
    await expect(page.getByText("Write the notes — Working", { exact: true })).toBeVisible();
    expect(
      await page.evaluate(() =>
        (window as unknown as { zolt: ZoltClient }).zolt.chats.interrupt({
          chatIds: ["demo-notes"],
        }),
      ),
    ).toEqual([{ chatId: "demo-notes", result: "interrupted" }]);
    const stale = await page.evaluate(async () => {
      try {
        await (window as unknown as { zolt: ZoltClient }).zolt.requests.answer({
          requestId: "demo-request",
          version: 2,
          choiceId: "allow_once",
        });
      } catch (error) {
        return (error as Error & { code: string }).code;
      }
    });
    expect(stale).toBe("stale");
    await page.evaluate(() =>
      (window as unknown as { zolt: ZoltClient }).zolt.requests.answer({
        requestId: "demo-request",
        version: 1,
        choiceId: "allow_once",
      }),
    );
    await expect
      .poll(async () =>
        parse(topicSchemas.requests, await topic("requests")).some(
          (request) => request.id === "demo-request",
        ),
      )
      .toBe(false);
    await page.clock.fastForward(5200);
    await expect
      .poll(async () => parse(topicSchemas.usage, await topic("usage")).today.costUsd)
      .toBeGreaterThan(initial.today.costUsd);
    expect(
      parse(topicSchemas.requests, await topic("requests")).some(
        (request) => request.type === "question",
      ),
    ).toBe(true);
    expect(await page.evaluate(() => typeof window.zoltDesktop)).toBe("undefined");
    expect(external).toEqual([]);
    await expect(page.locator("#error")).toHaveText("");
    await page.screenshot({ path: "output/playwright/views/mock-command-map.png" });
  } finally {
    await server.close();
  }
});
test("previews the minimal example with read alone without writing host files into it", async ({
  page,
}) => {
  const folder = "packages/view-api/examples/hello-view",
    server = await serveView(folder);
  try {
    await page.goto(server.url);
    const facts = await page.evaluate(() => (window as unknown as { zolt: ZoltClient }).zolt.ready);
    expect(facts).toMatchObject({ mock: true, granted: ["read"] });
    await expect(
      page.getByRole("button", { name: "Open Build the page", exact: true }),
    ).toBeVisible();
    const code = await page.evaluate(async () => {
      try {
        await (window as unknown as { zolt: ZoltClient }).zolt.chats.send({
          chatIds: ["demo-build"],
          text: "Test",
        });
      } catch (error) {
        return (error as Error & { code: string }).code;
      }
    });
    expect(code).toBe("not_granted");
    await expect(access(path.join(folder, "_host"))).rejects.toThrow();
  } finally {
    await server.close();
  }
});
