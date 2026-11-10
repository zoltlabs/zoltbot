import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { chromium, expect, test } from "@playwright/test";
import { handle } from "../../packages/core/src/index.js";
import { startDaemon } from "../../packages/daemon/src/api.js";
import type { CompanyPlan } from "../../packages/protocol/src/index.js";
import { runtimeFixture } from "../../tools/fakes/src/runtime-fixture.js";

test("organization ownership, initiative edits, approved reorg, reports and direct work stay usable", async () => {
  const f = await runtimeFixture("zoltbot.db");
  const at = new Date().toISOString();
  f.store.dispatch("project", (s) =>
    handle(
      s,
      {
        type: "create",
        kind: "project",
        value: {
          id: "co",
          name: "Example company",
          goal: "Launch onboarding",
          instructions: "",
          constraints: "Synthetic test only",
          roots: [],
          hierarchyDepth: 0,
          tags: [],
          requireCodeReview: false,
          skipFinalGateWhenReviewed: false,
          archived: false,
          createdAt: at,
        },
      },
      { commandId: "project", at, actor: { kind: "human", id: "fixture" } },
    ),
  );
  const daemon = await startDaemon({ dataDir: f.root, origins: ["http://127.0.0.1:5189"] });
  const socket = new WebSocket(daemon.url);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let n = 0;
  const rpc = (method: string, params: unknown, commandId?: string) =>
    new Promise<unknown>((resolve, reject) => {
      const id = ++n;
      socket.addEventListener(
        "message",
        (event) => {
          const response = JSON.parse(String(event.data));
          if (response.error) reject(Error(response.error.message));
          else resolve(response.result);
        },
        { once: true },
      );
      socket.send(
        JSON.stringify({ jsonrpc: "2.0", id, method, params, ...(commandId ? { commandId } : {}) }),
      );
    });
  await rpc("hello", { protocolVersion: 1, token: daemon.token });
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
    await rpc(
      "company.propose",
      {
        id: "org",
        projectId: "co",
        title: "Launch team",
        explanation: "Coordinate the launch",
        changes: [
          {
            kind: "team",
            id: "eng",
            name: "Engineering",
            parent: { type: "project", id: "co" },
            why: "Own implementation",
          },
          {
            kind: "chat",
            id: "lead",
            title: "Engineering lead",
            parent: { type: "subproject", id: "eng" },
            profileId: "profile",
            manager: true,
            why: "Coordinate execution",
          },
        ],
      },
      "org",
    );
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
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("http://127.0.0.1:5189/#projects/project/co");
    await page.getByText("Organization and work", { exact: false }).first().click();
    await expect(page.getByRole("heading", { name: "Proposed changes" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Approve Launch team", exact: true }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "Approve Launch team", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("button", { name: "Open Engineering lead", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Edit responsibilities for Engineering lead" }).click();
    await page
      .getByLabel("Responsibilities", { exact: true })
      .fill("Own onboarding delivery and verification");
    await page.getByLabel("Boundaries", { exact: true }).fill("Ask before publishing");
    await page.getByRole("button", { name: "Propose responsibilities", exact: true }).click();
    await page
      .getByRole("button", { name: "Approve Update responsibilities", exact: true })
      .click();
    await expect(
      page.getByText("Own onboarding delivery and verification", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Initiatives and tasks", exact: true }).click();
    await page.getByRole("button", { name: "Create initiative", exact: true }).click();
    await page.getByLabel("Initiative title", { exact: true }).fill("Onboarding launch");
    await page.getByLabel("Outcome", { exact: true }).fill("New customers can complete signup");
    await page
      .getByLabel("Acceptance criteria", { exact: true })
      .fill("Signup and error flows verified");
    await page
      .getByRole("combobox", { name: "Accountable owner", exact: true })
      .selectOption("lead");
    await page.getByRole("combobox", { name: "Team", exact: true }).selectOption("eng");
    await page.getByRole("button", { name: "Propose initiative", exact: true }).click();
    await page
      .getByRole("button", { name: "Approve Update initiative: Onboarding launch", exact: true })
      .click();
    await expect(
      page.getByText("New customers can complete signup", { exact: true }),
    ).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.screenshot({ path: "output/playwright/company-work-dark.png", fullPage: true });
    const initiative = daemon.store.snapshot(["initiativeRecord"]).initiativeRecord?.[0];
    await rpc(
      "company.assign",
      {
        value: {
          id: "bug",
          title: "Fix signup error",
          brief: "Fix synthetic validation",
          profileId: "profile",
          node: { type: "project", id: "co" },
          planned: true,
        },
      },
      "bug",
    );
    await expect(page.getByRole("button", { name: "Fix signup error", exact: true })).toBeVisible();
    await expect.poll(() => daemon.store.record("task", "bug")?.holdReason).toContain("Planned");
    await page.getByRole("button", { name: "Organization", exact: true }).click();
    await page.getByText("Propose an organization change", { exact: true }).click();
    await page.getByLabel("New name", { exact: true }).fill("Product engineering");
    await page.getByLabel("Why this helps", { exact: true }).fill("Clarify product ownership");
    await page.getByRole("button", { name: "Preview organization change", exact: true }).click();
    await page.getByRole("button", { name: "Approve Update organization", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Product engineering", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Project reports", exact: true }).click();
    await page.getByRole("button", { name: "Save current project report", exact: true }).click();
    await expect(page.getByText("Project report saved.", { exact: true })).toBeVisible();
    expect(daemon.store.snapshot(["projectBrief"]).projectBrief?.length).toBeGreaterThan(0);
    // Stale approval is rejected without modifying the newer organization.
    const stale = (await rpc(
      "company.propose",
      {
        id: "stale",
        projectId: "co",
        title: "Stale rename",
        explanation: "Old state",
        changes: [{ kind: "renameTeam", id: "eng", name: "Old name", why: "Test stale approval" }],
      },
      "stale",
    )) as CompanyPlan;
    daemon.dispatch(
      { type: "update", kind: "project", id: "co", changes: { goal: "Retention first" } },
      "priority-change",
    );
    await expect(
      rpc(
        "company.decide",
        { id: stale.id, version: stale.version, baseline: stale.baseline, approve: true },
        "stale-approve",
      ),
    ).rejects.toThrow("stale_plan");
    await page.getByRole("button", { name: "Approve Stale rename", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("fresh proposal");
    await page.getByRole("button", { name: "Decline Stale rename", exact: true }).click();
    await page.evaluate(() => {
      localStorage.setItem("zoltbot.theme.v1", "light");
    });
    await page.reload();
    await page.getByText("Organization and work", { exact: false }).first().click();
    await page.getByRole("button", { name: "Initiatives and tasks", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Edit Onboarding launch", exact: true }),
    ).toBeVisible();
    await page.setViewportSize({ width: 320, height: 900 });
    await page.getByRole("button", { name: "Hide sidebar", exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.screenshot({
      path: "output/playwright/company-work-light-narrow.png",
      fullPage: true,
    });
    expect(initiative?.managerThreadId).toBe("lead");
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    socket.close();
    await daemon.close();
    f.close();
  }
});
