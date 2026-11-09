import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { launch } from "./desktop.js";
import { rpc } from "./rpc.js";

async function openRules(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Approval rules", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Approval rules", exact: true })).toBeVisible();
}
async function beginGlobal(page: Page, prefix: string) {
  await page.getByRole("button", { name: "New rule", exact: true }).click();
  const form = page.getByRole("region", { name: "Create approval rule", exact: true });
  await form.getByLabel("Command prefix", { exact: true }).fill(prefix);
  await form.getByLabel("Rule scope", { exact: true }).selectOption("global");
  return form;
}

test("reviews command rules before saving, previews saved decisions, and revokes with current results in both themes", async () => {
  const fixture = await launch(),
    { page } = fixture;
  try {
    await openRules(page);
    if ((await page.locator("html").getAttribute("data-theme")) !== "light")
      await page.getByRole("button", { name: "Use light theme", exact: true }).click();
    const form = await beginGlobal(page, "git status");
    await form.getByLabel("Expires after", { exact: true }).selectOption("day");
    await form.getByRole("button", { name: "Review rule", exact: true }).click();
    await expect(
      form.getByRole("heading", { name: "Review approval rule", exact: true }),
    ).toBeFocused();
    expect(await rpc(page, "rule.list", {})).toEqual({ items: [] });
    await page.screenshot({ path: "output/playwright/rules-review-light.png", fullPage: true });
    expect((await new AxeBuilder({ page }).setLegacyMode().analyze()).violations).toEqual([]);
    await form.getByRole("button", { name: "Create allow rule", exact: true }).click();
    await expect(page.getByRole("button", { name: "New rule", exact: true })).toBeFocused();
    await expect(page.getByText("Rule created.", { exact: true })).toBeVisible();
    const table = page.getByRole("region", { name: "Saved approval rules", exact: true });
    await expect(table.getByRole("row")).toHaveCount(2);
    const command = page.getByLabel("Command to check", { exact: true });
    await command.fill("git status --short");
    await page.getByRole("button", { name: "Check command", exact: true }).click();
    await expect(page.getByText("Saved rule allows this command.", { exact: true })).toBeVisible();
    await page.screenshot({ path: "output/playwright/rules-light.png", fullPage: true });
    expect((await new AxeBuilder({ page }).setLegacyMode().analyze()).violations).toEqual([]);
    await page.getByRole("button", { name: "Use dark theme", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.screenshot({ path: "output/playwright/rules-dark.png", fullPage: true });
    expect((await new AxeBuilder({ page }).setLegacyMode().analyze()).violations).toEqual([]);
    await page.setViewportSize({ width: 660, height: 900 });
    await table.scrollIntoViewIfNeeded();
    await table.focus();
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => table.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
    await page.screenshot({ path: "output/playwright/rules-narrow-dark.png", fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    await table.getByRole("button", { name: "Revoke", exact: true }).click();
    await expect(page.getByText("Rule revoked.", { exact: true })).toBeVisible();
    await expect(page.getByText("Saved rule allows this command.", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Check command", exact: true }).click();
    await expect(page.getByText("Ask for approval.", { exact: true })).toBeVisible();
    await page.getByLabel("State filter", { exact: true }).selectOption("inactive");
    await expect(table.getByText("Revoked", { exact: true })).toBeVisible();
    const state = (await rpc(page, "snapshot.get", {})) as {
      entities: Record<string, Record<string, unknown>[]>;
    };
    expect(state.entities.rule).toHaveLength(1);
    expect(state.entities.rule?.[0]?.revokedAt).toBeDefined();
    expect(state.entities.audit).toHaveLength(2);
    expect(state.entities.session ?? []).toHaveLength(0);
  } finally {
    await fixture.cleanup();
  }
});

test("keeps exact rule drafts after malformed prefixes and destructive allow rejection and permits an explicit deny", async () => {
  const fixture = await launch(),
    { page } = fixture;
  try {
    await openRules(page);
    const form = await beginGlobal(page, "git status; echo unsafe");
    await form.getByRole("button", { name: "Review rule", exact: true }).click();
    await expect(form.getByRole("alert")).toContainText("without chaining");
    await expect(form.getByLabel("Command prefix", { exact: true })).toHaveValue(
      "git status; echo unsafe",
    );
    await form.getByLabel("Command prefix", { exact: true }).fill("rm -rf build");
    await form.getByRole("button", { name: "Review rule", exact: true }).click();
    await form.getByRole("button", { name: "Create allow rule", exact: true }).click();
    await expect(form.getByRole("alert")).toContainText("individual approval");
    expect(await rpc(page, "rule.list", {})).toEqual({ items: [] });
    await form.getByRole("button", { name: "Back", exact: true }).click();
    await expect(form.getByLabel("Command prefix", { exact: true })).toHaveValue("rm -rf build");
    await form.getByLabel("Decision", { exact: true }).selectOption("deny");
    await form.getByRole("button", { name: "Review rule", exact: true }).click();
    await form.getByRole("button", { name: "Create deny rule", exact: true }).click();
    await expect(page.getByText("Rule created.", { exact: true })).toBeVisible();
    await page.getByLabel("Command to check", { exact: true }).fill("rm -rf build");
    await page.getByRole("button", { name: "Check command", exact: true }).click();
    await expect(page.getByText("Saved rule denies this command.", { exact: true })).toBeVisible();
    const state = (await rpc(page, "snapshot.get", {})) as {
      entities: Record<string, Record<string, unknown>[]>;
    };
    expect(state.entities.rule).toHaveLength(1);
    expect(state.entities.session ?? []).toHaveLength(0);
  } finally {
    await fixture.cleanup();
  }
});

test("rejects a known private value in a rule before writing and preserves its editable draft", async () => {
  const fixture = await launch("chat"),
    { page } = fixture;
  const secret = "synthetic-private-rule-answer";
  try {
    await page.getByRole("button", { name: /Chat verification/ }).click();
    const editor = page.getByRole("textbox", { name: "Message Builder", exact: true });
    await editor.fill("secret_question");
    await editor.press("Enter");
    const card = page.getByRole("region", { name: "Pending request", exact: true });
    await card.getByLabel("Private answer", { exact: true }).fill(secret);
    await card.getByLabel("Private answer", { exact: true }).press("Enter");
    await expect(card).toHaveCount(0);
    await openRules(page);
    const form = await beginGlobal(page, `printf ${secret}`);
    await form.getByRole("button", { name: "Review rule", exact: true }).click();
    await form.getByRole("button", { name: "Create allow rule", exact: true }).click();
    await expect(form.getByRole("alert")).toContainText("Private values");
    await form.getByRole("button", { name: "Back", exact: true }).click();
    await expect(form.getByLabel("Command prefix", { exact: true })).toHaveValue(
      `printf ${secret}`,
    );
    const rules = (await rpc(page, "rule.list", {})) as { items: unknown[] };
    expect(rules.items).toHaveLength(0);
    for (const name of [
      "zoltbot.db",
      "zoltbot.db-wal",
      "frames.jsonl",
      "adapter.log",
      "daemon.log",
    ]) {
      const file = path.join(fixture.dataDir, name);
      if (existsSync(file)) expect(readFileSync(file).includes(Buffer.from(secret))).toBe(false);
    }
  } finally {
    await fixture.cleanup();
  }
});
