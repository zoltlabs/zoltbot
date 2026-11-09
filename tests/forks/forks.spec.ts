import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { chromium, expect, test } from "@playwright/test";
import { startDaemon } from "../../packages/daemon/src/api.js";
import { forkFixture } from "../../tools/fakes/src/fork-fixture.js";
import { ForkFakeSession } from "../../tools/fakes/src/fork-runtime.js";

const baseUrl = `http://127.0.0.1:${process.env.ZOLTBOT_FORK_TEST_PORT ?? "5191"}`;

test("native fork preview, create, inherited history and accessible controls", async () => {
  const seed = await forkFixture("zoltbot.db");
  seed.put("agentDefinition", {
    ...seed.store.record("agentDefinition", "fake"),
    id: "second-tool",
    displayName: "Second coding tool",
  });
  seed.put("agent", {
    ...seed.store.record("agent", "profile"),
    id: "second-profile",
    name: "Second profile",
    definitionId: "second-tool",
  });
  seed.store.close();
  let fail = false;
  let opens = 0;
  const natives: ForkFakeSession[] = [];
  const daemon = await startDaemon({
    dataDir: seed.root,
    origins: [baseUrl],
    runtimeHost: {
      async prepare(input) {
        return {
          cwd: seed.root,
          estimate: () => 1,
          configuration: input.previous?.configuration as Record<string, unknown>,
          async open(request) {
            opens++;
            if (fail) throw Error("injected_fork_failure");
            const native = new ForkFakeSession(
              request.fork?.targetNativeId ?? request.nativeId ?? crypto.randomUUID(),
            );
            natives.push(native);
            return native;
          },
        };
      },
    },
  });
  const browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.ZOLTBOT_HEADLESS_CHROMIUM ??
      (existsSync(chromium.executablePath())
        ? chromium.executablePath()
        : path.join(
            homedir(),
            "Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell",
          )),
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(
    ({ url, token }) => {
      window.zoltDesktop = {
        connection: async () => ({ url, token }),
        onConnectionChanged: () => () => {},
        visibleThread() {},
      };
    },
    { url: daemon.url, token: daemon.token },
  );
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.goto(`${baseUrl}/#chat/thread`);
    await page.getByRole("button", { name: "Fork conversation", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Fork conversation" });
    await expect(dialog.getByRole("button", { name: "Create native fork" })).toBeEnabled();
    await dialog.getByLabel("Conversation name").fill("Independent child");
    expect((await new AxeBuilder({ page }).include("dialog").analyze()).violations).toEqual([]);
    await page.screenshot({ path: "output/playwright/forks-preview.png" });
    await dialog.getByRole("button", { name: "Create native fork", exact: true }).click();
    await expect(page.getByText("Inherited conversation · read only")).toBeVisible();
    const child = daemon.store
      .snapshot(["thread"])
      .thread?.find((r) => r.title === "Independent child");
    expect(child?.fork).toMatchObject({ sourceThreadId: "thread", inheritedHistoryPresent: true });
    await page.getByText("Inherited conversation · read only").click();
    await expect(page.getByText("SOURCE_ONLY", { exact: true })).toBeVisible();
    await page.screenshot({ path: "output/playwright/forks-child.png" });
    await page.goto(`${baseUrl}/#chat/thread`);
    await page.getByRole("button", { name: "Fork conversation", exact: true }).click();
    await dialog.getByLabel("Destination coding tool").selectOption("second-profile");
    await expect(dialog.getByRole("button", { name: "Create copied-context fork" })).toBeEnabled();
    await expect(dialog.getByText(/Copied-context fork: 1 visible message/)).toBeVisible();
    await dialog.getByLabel("Conversation name").fill("Cross-tool copy");
    expect((await new AxeBuilder({ page }).include("dialog").analyze()).violations).toEqual([]);
    await page.screenshot({ path: "output/playwright/copied-fork-preview.png" });
    const beforeCopy = opens;
    await dialog.getByRole("button", { name: "Create copied-context fork" }).click();
    await expect(page.getByText("Copied conversation · read only")).toBeVisible();
    expect(opens).toBe(beforeCopy);
    const copied = daemon.store
      .snapshot(["thread"])
      .thread?.find((r) => r.title === "Cross-tool copy");
    expect(copied).toMatchObject({
      agentId: "second-profile",
      fork: { kind: "copied", inheritedHistoryPresent: false },
    });
    await page.getByText("Copied conversation · read only").click();
    await expect(page.getByText("SOURCE_ONLY", { exact: true })).toBeVisible();
    const composer = page.getByRole("form", { name: "Message composer" });
    await composer.locator("textarea").fill("CONTINUE_IN_SECOND_TOOL");
    await composer.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(() => natives.at(-1)?.received.length).toBe(1);
    expect(JSON.stringify(natives.at(-1)?.received[0])).toContain("SOURCE_ONLY");
    expect(JSON.stringify(natives.at(-1)?.received[0])).toContain("CONTINUE_IN_SECOND_TOOL");
    await composer.locator("textarea").fill("FOLLOW_UP");
    await composer.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(() => natives.at(-1)?.received.length).toBe(2);
    expect(JSON.stringify(natives.at(-1)?.received[1])).not.toContain("SOURCE_ONLY");
    await page.screenshot({ path: "output/playwright/copied-fork-child.png" });
    await page.goto(`${baseUrl}/#chat/thread`);
    fail = true;
    await page.getByRole("button", { name: "Fork conversation", exact: true }).click();
    await dialog.getByLabel("Conversation name").fill("Needs review");
    await dialog.getByRole("button", { name: "Create native fork", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("attempt is saved");
    const dispatched = opens;
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.reload();
    await page.getByRole("button", { name: "Fork conversation", exact: true }).click();
    await expect(dialog.getByLabel("Conversation name")).toHaveValue("Needs review");
    await dialog.getByRole("button", { name: "Check saved attempt", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("attempt is saved");
    expect(opens).toBe(dispatched);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    await daemon.close();
    await rm(seed.root, { recursive: true, force: true });
  }
});
