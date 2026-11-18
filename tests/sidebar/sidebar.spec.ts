import { AxeBuilder } from "@axe-core/playwright";
import { chromium, expect, test } from "@playwright/test";
import { compareFixture } from "../../tools/fakes/src/compare-fixture.js";

test("navigate and grow a repo's project team, with accessible responsive navigation", async () => {
  const f = await compareFixture();
  const at = new Date().toISOString();
  for (const [id, name] of [
    ["repo", "acme-health"],
    ["second-repo", "cicero-app"],
  ])
    f.daemon.dispatch(
      {
        type: "create",
        kind: "project",
        value: {
          id,
          name,
          goal: "",
          instructions: "",
          constraints: "",
          roots: [],
          hierarchyDepth: 3,
          tags: [],
          requireCodeReview: false,
          skipFinalGateWhenReviewed: false,
          archived: false,
          createdAt: at,
        },
      },
      `repo-${id}`,
    );
  f.daemon.dispatch(
    {
      type: "create",
      kind: "subproject",
      value: {
        id: "onboarding",
        projectId: "repo",
        name: "Onboarding",
        label: "Project",
        goal: "",
        instructions: "",
        depth: 1,
        archived: false,
        createdAt: at,
      },
    },
    "project-onboarding",
  );
  f.daemon.dispatch(
    {
      type: "update",
      kind: "thread",
      id: "thread",
      changes: {
        projectId: "repo",
        node: { type: "subproject", id: "onboarding" },
        title: "Designer",
        titleSource: "human",
      },
    },
    "employee-designer",
  );
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.ZOLTBOT_HEADLESS_CHROMIUM
      ? { executablePath: process.env.ZOLTBOT_HEADLESS_CHROMIUM }
      : {}),
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(
    ({ url, token }) => {
      localStorage.setItem("zoltbot.onboarding.v1", "done");
      window.zoltDesktop = {
        connection: async () => ({ url, token }),
        onConnectionChanged: () => () => {},
        visibleThread() {},
      };
    },
    { url: f.daemon.url, token: f.daemon.token },
  );
  try {
    await page.goto("http://127.0.0.1:5196/#chief");
    const sidebar = page.getByRole("complementary", { name: "Workspace sidebar" });
    await expect(sidebar.getByRole("button", { name: "Zolt", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(sidebar.getByRole("button", { name: "Quick chat", exact: true })).toHaveCount(0);
    await sidebar.getByRole("button", { name: "Designer", exact: true }).click();
    await expect(page).toHaveURL(/#chat\/thread$/);
    await expect(page.locator(".sidebar-collapsed")).toHaveCount(0);
    await expect(sidebar.locator(".bot-avatar")).toHaveCount(2);
    const originalFace = await sidebar
      .getByRole("button", { name: "Designer", exact: true })
      .locator(".bot-silhouette")
      .getAttribute("d");
    const layout = await page.locator(".chat-conversation").evaluate((pane) => {
      const composer = pane.querySelector(".chat-composer")?.getBoundingClientRect();
      if (!composer) throw new Error("Composer missing");
      const bounds = pane.getBoundingClientRect();
      return { gap: composer.left - bounds.left, ratio: composer.width / bounds.width };
    });
    expect(layout.gap).toBeLessThan(35);
    expect(layout.ratio).toBeGreaterThan(0.9);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await sidebar.getByRole("button", { name: "Designer", exact: true }).hover();
    expect(
      await sidebar
        .getByRole("button", { name: "Designer", exact: true })
        .locator(".bot-eyes")
        .evaluate((node) => getComputedStyle(node).animationName),
    ).toBe("bot-blink");
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(
      await sidebar
        .getByRole("button", { name: "Designer", exact: true })
        .locator(".bot-eyes")
        .evaluate((node) => getComputedStyle(node).animationName),
    ).toBe("none");
    await expect(page.locator(".chat-header .bot-silhouette")).toHaveAttribute(
      "d",
      originalFace ?? "",
    );

    await sidebar.getByRole("button", { name: "Collapse Onboarding", exact: true }).click();
    await expect(sidebar.getByRole("button", { name: "Designer", exact: true })).toHaveCount(0);
    await sidebar.getByRole("button", { name: "Expand Onboarding", exact: true }).focus();
    await page.keyboard.press("Space");
    await expect(sidebar.getByRole("button", { name: "Designer", exact: true })).toBeVisible();
    await sidebar.getByRole("button", { name: "Add employee to Onboarding" }).click();
    await page.getByLabel("Employee name", { exact: true }).fill("Developer");
    await page.getByRole("button", { name: "Add employee", exact: true }).click();
    await expect(page).toHaveURL(/#chat\//);
    await expect(sidebar.getByRole("button", { name: "Developer", exact: true })).toBeVisible();
    const employeeFaces = await sidebar
      .locator(".scope-chat .bot-avatar")
      .evaluateAll((nodes) => nodes.map((node) => node.className));
    expect(new Set(employeeFaces).size).toBe(employeeFaces.length);
    await expect(
      sidebar.getByRole("button", { name: "Designer", exact: true }).locator(".bot-silhouette"),
    ).toHaveAttribute("d", originalFace ?? "");
    const employee = f.daemon.store.record(
      "thread",
      decodeURIComponent(page.url().split("#chat/")[1] ?? ""),
    );
    expect(employee?.node).toEqual({ type: "subproject", id: "onboarding" });
    await sidebar.getByRole("button", { name: "Add project to acme-health" }).click();
    await page.getByLabel("Project name", { exact: true }).fill("Health integration");
    await page.getByRole("button", { name: "Create project", exact: true }).click();
    await expect(
      sidebar.getByRole("button", { name: "Health integration", exact: true }),
    ).toBeVisible();
    await sidebar.getByRole("button", { name: "Add repo", exact: true }).click();
    await expect(page.getByRole("form", { name: "New repo" })).toBeVisible();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await sidebar.getByRole("button", { name: "Workspace tools", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "Overview", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(sidebar.getByRole("button", { name: "Workspace tools" })).toBeFocused();
    await sidebar.getByRole("button", { name: "Designer", exact: true }).click();
    await page
      .getByRole("textbox", { name: "Message First", exact: true })
      .fill(
        "Take time to explain the onboarding rollout plan and the checks we should run before launch.",
      );
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const workingFace = sidebar.locator('.scope-chat .bot-avatar[data-state="working"]');
    await expect(workingFace).toBeVisible();
    expect(
      await workingFace
        .locator(".bot-body")
        .evaluate((node) => getComputedStyle(node).animationName),
    ).toBe("bot-working");
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(
      await workingFace
        .locator(".bot-body")
        .evaluate((node) => getComputedStyle(node).animationName),
    ).toBe("none");

    await expect(page.locator(".chat-timeline")).toContainText("First answer");
    const messageBounds = await page.locator(".chat-virtual-list").evaluate((node) => {
      const list = node.getBoundingClientRect();
      const composer = document.querySelector(".chat-composer")?.getBoundingClientRect();
      if (!composer) throw new Error("Composer missing");
      return { left: Math.abs(list.left - composer.left), width: list.width };
    });
    expect(messageBounds.left).toBeLessThan(2);
    expect(messageBounds.width).toBeGreaterThan(720);
    for (const theme of ["dark", "light"]) {
      await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
      await sidebar.getByRole("button", { name: "Designer", exact: true }).click();
      await page.screenshot({ path: `output/playwright/sidebar-${theme}.png` });
      expect(
        (await new AxeBuilder({ page }).include("#workspace-sidebar").analyze()).violations,
      ).toEqual([]);
      await page.evaluate(() => (document.documentElement.style.fontSize = "200%"));
      expect(await sidebar.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
      await page.screenshot({ path: `output/playwright/sidebar-${theme}-200.png` });
      await page.evaluate(() => (document.documentElement.style.fontSize = ""));
    }
    await page.setViewportSize({ width: 320, height: 800 });
    await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Workspace navigation" })).toBeVisible();
    await page.screenshot({ path: "output/playwright/sidebar-narrow.png" });
    expect(
      (await new AxeBuilder({ page }).include("#workspace-sidebar").analyze()).violations,
    ).toEqual([]);
    await sidebar.getByRole("button", { name: "Developer", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Workspace navigation" })).not.toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.setViewportSize({ width: 1440, height: 1000 });
    await expect(sidebar.getByRole("button", { name: "Add repo", exact: true })).toBeVisible();
    await sidebar.getByRole("button", { name: "Add repo", exact: true }).click();
    await page.getByLabel("Repo name", { exact: true }).fill("docs-app");
    await page.getByRole("button", { name: "Create repo", exact: true }).click();
    await expect(sidebar.getByRole("button", { name: "docs-app", exact: true })).toBeVisible();
    await sidebar.getByRole("button", { name: "Add project to docs-app" }).click();
    const longName =
      "Accessibility and internationalization across the entire onboarding experience";
    await page.getByLabel("Project name", { exact: true }).fill(longName);
    await page.getByRole("button", { name: "Create project", exact: true }).click();
    const longRow = sidebar.getByRole("button", { name: longName, exact: true });
    await expect(longRow).toBeVisible();
    await page.evaluate(() => (document.documentElement.style.fontSize = "200%"));
    expect(await sidebar.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    await page.evaluate(() => (document.documentElement.style.fontSize = ""));
    await sidebar.getByRole("button", { name: "Workspace tools", exact: true }).click();
    await page.getByRole("menuitem", { name: "Tasks", exact: true }).click();
    await expect(page).toHaveURL(/#tasks$/);
    await sidebar.getByRole("button", { name: "docs-app", exact: true }).click();
    await expect(page.getByRole("form", { name: "New project" })).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    await f.close();
  }
});
