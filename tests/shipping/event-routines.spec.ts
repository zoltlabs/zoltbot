import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { chromium, expect, test } from "@playwright/test";
import { handle } from "../../packages/core/src/index.js";
import { startDaemon } from "../../packages/daemon/src/api.js";
import { runtimeFixture } from "../../tools/fakes/src/runtime-fixture.js";

test("event draft → dry run → saved paused → enabled → paused, with theme and narrow checks", async () => {
  const f = await runtimeFixture("zoltbot.db");
  f.store.dispatch("adapter", (state) =>
    handle(
      state,
      { type: "update", kind: "agentDefinition", id: "fake", changes: { adapter: "claude" } },
      { commandId: "adapter", at: "2026-11-06T12:00:00Z", actor: { kind: "human", id: "fixture" } },
    ),
  );
  f.store.dispatch("project", (state) =>
    handle(
      state,
      {
        type: "create",
        kind: "project",
        value: {
          id: "p",
          name: "Example workspace",
          goal: "",
          instructions: "",
          constraints: "",
          roots: [],
          hierarchyDepth: 1,
          tags: [],
          requireCodeReview: false,
          skipFinalGateWhenReviewed: false,
          archived: false,
          createdAt: "2026-11-06T12:00:00Z",
        },
      },
      { commandId: "project", at: "2026-11-06T12:00:00Z", actor: { kind: "human", id: "fixture" } },
    ),
  );
  let deliver = false;
  let now = "2026-11-06T12:00:00.000Z";
  const workflow = {
    id: 99,
    workflow_id: 3,
    run_attempt: 1,
    head_sha: "a".repeat(40),
    head_branch: "main",
    updated_at: "2026-11-06T12:00:30.000Z",
    status: "completed",
    conclusion: "failure",
  };
  const daemon = await startDaemon({
    routineClock: () => now,
    routinePollMs: 100,
    dataDir: f.root,
    origins: ["http://127.0.0.1:5189"],
    eventRoutineTransport: async (endpoint) => {
      if (endpoint === "/user") return { id: 42 };
      if (endpoint === "/repos/example/app") return { id: 7, full_name: "example/app" };
      if (endpoint.includes("/pulls?")) return [{ number: 10 }];
      if (endpoint.endsWith("/pulls/10"))
        return {
          state: "open",
          head: { sha: "b".repeat(40), ref: "feature" },
          base: { sha: "a".repeat(40) },
          requested_reviewers: [{ id: 42 }],
          requested_teams: [],
          title: "Review fixture",
        };
      if (endpoint.includes("/timeline"))
        return [
          {
            id: 123,
            event: "review_requested",
            requested_reviewer: { id: 42 },
            created_at: "2026-11-06T12:01:30.000Z",
          },
        ];
      if (endpoint.includes("/actions/runs?"))
        return { workflow_runs: deliver ? [workflow] : [], total_count: deliver ? 1 : 0 };
      if (endpoint.includes("/branches/")) return { commit: { sha: workflow.head_sha } };
      if (endpoint.includes("/jobs?"))
        return { jobs: [{ name: "Unit tests", conclusion: "failure", steps: [] }] };
      if (endpoint.endsWith("/99")) return workflow;
      throw new Error("fixture_unexpected_endpoint");
    },
  });
  const browser = await chromium.launch({
    headless: true,
    executablePath: existsSync(chromium.executablePath())
      ? chromium.executablePath()
      : path.join(
          homedir(),
          "Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell",
        ),
  });
  try {
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
    await page.goto("http://127.0.0.1:5189/#routines");
    await page.getByRole("button", { name: "New routine", exact: true }).click();
    await page.getByLabel("GitHub owner/repository").fill("example/app");
    await page
      .getByRole("form", { name: "New event routine" })
      .getByLabel("Workspace", { exact: true })
      .selectOption("p");
    await page.getByLabel("Profile", { exact: true }).selectOption("profile");
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.screenshot({
      path: "output/playwright/event-routines-create-dark.png",
      fullPage: true,
    });
    await page.getByRole("button", { name: "Save draft", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Preview test event", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Check GitHub account", exact: true }).click();
    await page.getByRole("button", { name: "Preview test event", exact: true }).click();
    await expect(page.getByText("Dry run · No task started", { exact: true })).toBeVisible();
    await page.screenshot({
      path: "output/playwright/event-routines-preview-dark.png",
      fullPage: true,
    });
    await page.getByRole("button", { name: "Save paused", exact: true }).click();
    await expect(page.getByText("Saved · Paused", { exact: true })).toBeVisible();
    expect(daemon.store.snapshot(["task"]).task ?? []).toHaveLength(0);
    await page.getByRole("button", { name: "Enable routine", exact: true }).click();
    await expect(page.getByText("Enabled", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Pause routine", exact: true }).click();
    await expect(page.getByText("Saved · Paused", { exact: true })).toBeVisible();
    await page.screenshot({ path: "output/playwright/event-routines-dark.png", fullPage: true });
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.evaluate(() => {
      localStorage.setItem("zoltbot.theme.v1", "light");
      localStorage.setItem("zoltbot.fontScale.v1", "150");
    });
    await page.reload();
    await expect(page.getByText("Saved · Paused", { exact: true })).toBeVisible();
    await page.screenshot({ path: "output/playwright/event-routines-light.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Hide sidebar", exact: true }).click();
    await expect(page.getByRole("button", { name: "Enable routine", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: "output/playwright/event-routines-narrow.png", fullPage: true });
    await page
      .getByRole("button", { name: "Enable routine", exact: true })
      .scrollIntoViewIfNeeded();
    await expect(
      page.getByRole("button", { name: "Enable routine", exact: true }),
    ).toBeInViewport();
    expect(
      await page
        .locator(".event-routine-card")
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    await page.screenshot({
      path: "output/playwright/event-routines-narrow-controls.png",
      fullPage: true,
    });
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole("button", { name: "New routine", exact: true }).click();
    const form = page.getByRole("form", { name: "New event routine" });
    await form.getByLabel("Routine name").fill("Investigate Sentry issues");
    await form.getByLabel("When this happens").selectOption("sentry.issue_created");
    await form.getByLabel("Sentry organization/project").fill("example/ios");
    await form.getByLabel("Workspace", { exact: true }).selectOption("p");
    await form.getByLabel("Profile", { exact: true }).selectOption("profile");
    await form.getByRole("button", { name: "Save draft", exact: true }).click();
    const card = page.getByRole("region", { name: "Investigate Sentry issues", exact: true });
    await card.getByRole("button", { name: "Open Connections", exact: true }).click();
    await expect(page.getByRole("region", { name: "Routine connection drafts" })).toBeVisible();
    await page.reload();
    await page.getByRole("button", { name: "Review draft in Routines" }).click();
    await expect(card).toBeVisible();
    await expect(card.getByText("Draft", { exact: true })).toBeVisible();
    expect(daemon.store.snapshot(["task"]).task ?? []).toHaveLength(0);
    const github = page.getByRole("region", { name: "Diagnose failed CI", exact: true });
    await github.getByRole("button", { name: "Enable routine", exact: true }).click();
    await expect(github.getByText("Enabled", { exact: true })).toBeVisible();
    deliver = true;
    now = "2026-11-06T12:01:00.000Z";
    await expect.poll(() => daemon.store.snapshot(["task"]).task?.length ?? 0).toBe(1);
    await page.getByText("Event and admission details", { exact: true }).click();
    await expect(page.getByRole("link", { name: "Open source on GitHub" })).toHaveAttribute(
      "href",
      "https://github.com/example/app/actions/runs/99",
    );
    await page.screenshot({ path: "output/playwright/event-routines-history.png", fullPage: true });
    await page.getByRole("button", { name: "Open task", exact: true }).click();
    await expect(page).toHaveURL(/chat/);
    await page.goto("http://127.0.0.1:5189/#routines");
    await page.getByRole("button", { name: "New routine", exact: true }).click();
    await form.getByLabel("Routine name").fill("Review requests");
    await form.getByLabel("When this happens").selectOption("github.review_requested");
    await form.getByLabel("GitHub owner/repository").fill("example/app");
    await form.getByLabel("Workspace", { exact: true }).selectOption("p");
    await form.getByLabel("Profile", { exact: true }).selectOption("profile");
    await form.getByLabel("Maximum runs per UTC day").fill("3");
    await form.getByRole("button", { name: "Save draft", exact: true }).click();
    const reviews = page.getByRole("region", { name: "Review requests", exact: true });
    await reviews.getByRole("button", { name: "Check GitHub account", exact: true }).click();
    await reviews.getByRole("button", { name: "Preview test event", exact: true }).click();
    await reviews.getByRole("button", { name: "Save paused", exact: true }).click();
    await reviews.getByRole("button", { name: "Enable routine", exact: true }).click();
    await expect(reviews.getByText("Enabled", { exact: true })).toBeVisible();
    now = "2026-11-06T12:02:00.000Z";
    await expect
      .poll(() =>
        daemon.store
          .snapshot(["routineOccurrence"])
          .routineOccurrence?.some(
            (row) => (row.sourceEvent as { kind?: string })?.kind === "github.review_requested",
          ),
      )
      .toBe(true);
    const prLink = page.locator('a[href="https://github.com/example/app/pull/10"]');
    await prLink.locator("..").getByText("Event and admission details", { exact: true }).click();
    await expect(prLink).toBeVisible();
    await page.screenshot({ path: "output/playwright/event-routines-review.png", fullPage: true });
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    await daemon.close();
    f.close();
  }
});
