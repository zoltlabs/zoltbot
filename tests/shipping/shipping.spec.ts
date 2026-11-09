import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { chromium, expect, test } from "@playwright/test";
import { startDaemon } from "../../packages/daemon/src/api.js";
import { seedShipping } from "../../packages/daemon/src/github/test-fixture.js";
import { openStore } from "../../packages/store/src/index.js";

async function fixture() {
  await mkdir(".cache/e2e", { recursive: true });
  const root = await mkdtemp(path.resolve(".cache/e2e/shipping-"));
  const seed = await openStore(path.join(root, "zoltbot.db"));
  const data = await seedShipping(seed, root);
  seed.close();
  const daemon = await startDaemon({
    dataDir: root,
    origins: ["http://127.0.0.1:5189"],
    githubClient: data.client,
    githubPublishing: data.publishing,
    interactionHost: {
      registerSecret() {},
      requiresSecretReply() {
        return false;
      },
      async respond() {},
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
  const page = await context.newPage(),
    errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("http://127.0.0.1:5189/#tasks");
  await expect(page.getByText("Connected to local daemon", { exact: true })).toBeVisible();
  return {
    ...data,
    daemon,
    page,
    errors,
    async close() {
      await browser.close();
      await daemon.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("publish → durable approval → PR → selected feedback → original task revision", async () => {
  const f = await fixture(),
    page = f.page;
  try {
    await page.getByRole("button", { name: "Open shipping for Fix login timeout" }).click();
    const panel = page.getByRole("complementary", { name: "Shipping · Fix login timeout" });
    await panel.getByRole("button", { name: "Create pull request…", exact: true }).click();
    await panel.getByLabel("Publishing branch").fill("zoltbot/task");
    await panel.getByRole("button", { name: "Review publication", exact: true }).click();
    await panel.getByRole("button", { name: "Push and create draft PR", exact: true }).click();
    await expect(panel.getByText(/Approve publication in Needs you/)).toBeVisible();
    await panel.getByRole("button", { name: "Open Needs you for Git approvals" }).click();
    await page.getByRole("button", { name: /^Approve/ }).click();
    await expect
      .poll(() => f.daemon.store.snapshot(["interaction"]).interaction?.[0]?.state)
      .toBe("answered");
    // More stays open once a page inside it has been visited; only open it if it is closed.
    const more = page
      .getByRole("navigation", { name: "Workspace", exact: true })
      .locator("details");
    if (!(await more.evaluate((el) => (el as HTMLDetailsElement).open)))
      await more.locator("summary").click();
    await page.getByRole("button", { name: "Tasks", exact: true }).click();
    await page.getByRole("button", { name: "Open shipping for Fix login timeout" }).click();
    await panel.getByRole("button", { name: "Reconcile operation", exact: true }).click();
    await expect(panel.getByText("PR #482 · Draft · open", { exact: true })).toBeVisible();
    expect(f.state.pushes).toBe(1);
    expect(f.state.creates).toBe(1);
    await panel.getByRole("button", { name: "Show diagnostics", exact: true }).click();
    await expect(
      panel.getByText("file.txt:1 Cancellation case failed", { exact: true }),
    ).toBeVisible();
    await panel.getByRole("checkbox", { name: /Select feedback from reviewer/ }).check();
    await panel
      .getByLabel("Your instruction (optional)")
      .fill("Cover this case without changing the API.");
    await panel.getByRole("button", { name: "Review selected feedback…" }).click();
    await expect(
      panel.getByText(/Cover this case without changing the API\./).last(),
    ).toBeVisible();
    await panel.getByRole("button", { name: "Send selected feedback", exact: true }).click();
    await expect.poll(() => f.daemon.store.record("task", "task")?.revision).toBe(2);
    const task = f.daemon.store.record("task", "task");
    expect(task?.workspaceId).toBe(f.binding.operationId);
    expect(task?.threadId).toBe("task:thread");
    expect(f.state.pushes).toBe(1);
    await page.screenshot({ path: "output/playwright/shipping-dark.png", fullPage: true });
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await panel.getByRole("button", { name: "Close shipping" }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("radio", { name: "Light", exact: true }).check();
    await page.goto("http://127.0.0.1:5189/#tasks/task/shipping");
    await expect(panel).toBeVisible();
    await page.screenshot({ path: "output/playwright/shipping-light.png", fullPage: true });
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(panel).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: "output/playwright/shipping-narrow.png", fullPage: true });
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
});

test("link, stale refresh, accepted-task feedback and guarded merge UI", async () => {
  const f = await fixture(),
    page = f.page;
  try {
    await page.getByRole("button", { name: "Open shipping for Fix login timeout" }).click();
    const panel = page.getByRole("complementary", { name: "Shipping · Fix login timeout" });
    await panel.getByRole("button", { name: "Link existing PR…" }).click();
    await panel.getByLabel("GitHub pull request URL").fill(f.snapshot.url);
    await panel.getByRole("button", { name: "Review link", exact: true }).click();
    await panel.getByRole("button", { name: "Link pull request", exact: true }).click();
    await expect(panel.getByText("PR #482 · Draft · open", { exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Review merge…" })).toBeDisabled();
    f.state.failPull = true;
    await panel.getByRole("button", { name: "Refresh GitHub", exact: true }).click();
    await expect(panel.getByRole("alert")).toBeVisible();
    await expect(panel.getByText("PR #482 · Draft · open", { exact: true })).toBeVisible();
    f.state.failPull = false;
    f.daemon.dispatch({ type: "review", id: "task", revision: 1, decision: "accept" }, "accept");
    await panel.getByRole("button", { name: "Refresh GitHub", exact: true }).click();
    await panel.getByRole("checkbox", { name: /Select feedback from reviewer/ }).check();
    await panel.getByRole("button", { name: "Review selected feedback…" }).click();
    await expect(
      panel.getByText("Reopens the accepted task as revision 2.", { exact: true }),
    ).toBeVisible();
    await panel.getByRole("button", { name: "Cancel", exact: true }).click();
    f.snapshot.draft = false;
    f.snapshot.mergeState = "CLEAN";
    f.snapshot.reviewDecision = "APPROVED";
    f.snapshot.checks = f.snapshot.checks.map((c) => ({ ...c, state: "SUCCESS" }));
    f.snapshot.threads = f.snapshot.threads.map((t) => ({ ...t, resolved: true }));
    await panel.getByRole("button", { name: "Refresh GitHub", exact: true }).click();
    await panel.getByRole("button", { name: "Review merge…" }).click();
    await panel.getByRole("button", { name: "Merge #482 on GitHub", exact: true }).click();
    await expect(
      panel.getByText(/Merged on GitHub\. Your local destination branch is unchanged/),
    ).toBeVisible();
    expect(f.state.merges).toBe(1);
    expect(f.state.pushes).toBe(0);
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
});
