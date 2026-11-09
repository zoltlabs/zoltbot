import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { launch, showConversationDetails } from "./desktop.js";
import { rpc } from "./rpc.js";

/** Connect the detected tools, skip the optional steps and stop on the first-project screen. */
async function finishSetup(page: Page) {
  await page.getByRole("button", { name: /^Connect \d+ agents?$/ }).click();
  await page.getByRole("button", { name: "Skip for now", exact: true }).click();
  await page.getByRole("button", { name: "Skip for now", exact: true }).click();
  await page.getByRole("button", { name: "Finish setup", exact: true }).click();
  await expect(page.getByRole("heading", { name: "You’re all set", exact: true })).toBeVisible();
}

test("creates a starter from detected tools, connects explicitly, and reuses it when setup is reopened", async () => {
  const fixture = await launch("doctor"),
    { page } = fixture;
  try {
    await page.getByRole("button", { name: "Set up coding agents", exact: true }).click();
    await page.getByRole("button", { name: "Get started", exact: true }).click();
    const choice = page.getByRole("checkbox", { name: "Use Fixture coding tool", exact: true });
    await expect(choice).toBeChecked();
    await expect(
      page
        .getByRole("region", { name: "Detected coding agents", exact: true })
        .getByText("Ready", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("1 broken install ignored", { exact: true })).toBeVisible();
    if ((await page.locator("html").getAttribute("data-theme")) !== "light")
      await page.getByRole("button", { name: "Use light theme", exact: true }).click();
    await page.screenshot({ path: "output/playwright/setup-findings-light.png", fullPage: true });
    expect((await new AxeBuilder({ page }).setLegacyMode().analyze()).violations).toEqual([]);
    await page.getByRole("button", { name: "Use dark theme", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.screenshot({ path: "output/playwright/setup-findings-dark.png", fullPage: true });
    expect((await new AxeBuilder({ page }).setLegacyMode().analyze()).violations).toEqual([]);
    await finishSetup(page);
    await page.getByRole("button", { name: "Open chat", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "Message Fixture coding tool", exact: true });
    await expect(editor).toBeFocused();
    await expect(editor).toHaveValue("");
    expect(existsSync(path.join(fixture.dataDir, "reference-native.json"))).toBe(false);
    await expect(page.getByRole("button", { name: "Connect", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(page.getByRole("button", { name: "Connect", exact: true })).toHaveCount(0);
    await editor.fill("Say hello");
    await editor.press("Enter");
    await expect(page.getByText("ok", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Coding agents", exact: true }).click();
    await page.getByRole("button", { name: "Open workspace setup", exact: true }).click();
    await page.getByRole("button", { name: "Get started", exact: true }).click();
    await expect(choice).toBeChecked();
    await finishSetup(page);
    await page.getByRole("button", { name: "Open chat", exact: true }).click();
    await expect(page.getByText("ok", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Overview", exact: true }).click();
    await expect(
      page
        .getByRole("region", { name: "Workspace summary", exact: true })
        .getByText("1", { exact: true }),
    ).toHaveCount(1);
    await expect(page.getByRole("button", { name: /New conversation/ })).toHaveCount(1);
  } finally {
    await fixture.cleanup();
  }
});

test("can skip setup without scanning native tools or creating profiles", async () => {
  const fixture = await launch("doctor"),
    { page } = fixture;
  try {
    await page.getByRole("button", { name: "Set up coding agents", exact: true }).click();
    await page.getByRole("button", { name: "Skip, I will add agents myself", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Overview", exact: true, level: 1 }),
    ).toBeVisible();
    // The launch-time update check may run --version; skipping must not check logins.
    const witness = path.join(fixture.dataDir, "native-checks.jsonl");
    const calls = existsSync(witness)
      ? readFileSync(witness, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as string[])
      : [];
    expect(calls.filter((args) => args[0] !== "--version")).toEqual([]);
    const state = (await rpc(page, "snapshot.get", {})) as {
      entities: Record<string, unknown[]>;
    };
    expect(state.entities.agent ?? []).toHaveLength(0);
    await expect(
      page.getByRole("button", { name: "Set up coding agents", exact: true }),
    ).toBeVisible();
  } finally {
    await fixture.cleanup();
  }
});

test("uses an explicitly chosen imported project and reuses conversations only within that project", async () => {
  const fixture = await launch("doctor"),
    { page } = fixture;
  try {
    await page.getByRole("button", { name: "Set up coding agents", exact: true }).click();
    await page.getByRole("button", { name: "Get started", exact: true }).click();
    await page.getByRole("button", { name: /^Connect \d+ agents?$/ }).click();
    await page
      .getByRole("button", { name: "Choose sources and folders yourself", exact: true })
      .click();
    await page.getByRole("checkbox", { name: "Scan code folders I choose", exact: true }).check();
    await page
      .getByRole("textbox", { name: "Code folder paths", exact: true })
      .fill(path.join(fixture.dataDir, "source-home/code"));
    await page
      .getByRole("checkbox", {
        name: "Read metadata from these selected sources and folders",
        exact: true,
      })
      .check();
    await page.getByRole("button", { name: "Preview metadata", exact: true }).click();
    await page.getByRole("checkbox", { name: "Keep project from git", exact: true }).check();
    await page.getByRole("button", { name: "Import selected metadata", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Saved 1 selected metadata item");
    await page.getByRole("button", { name: "Back to coding tools", exact: true }).click();
    await page.getByRole("button", { name: "Skip for now", exact: true }).click();
    await page.getByRole("button", { name: "Skip for now", exact: true }).click();
    await page.getByRole("button", { name: "Finish setup", exact: true }).click();
    const state = (await rpc(page, "snapshot.get", {})) as {
      entities: Record<string, Record<string, unknown>[]>;
    };
    const projectId = String(state.entities.project?.[0]?.id);
    const projectName = String(state.entities.project?.[0]?.name);
    const projects = page.getByRole("radiogroup", { name: "Projects", exact: true });
    await expect(projects.getByRole("radio", { name: "No project", exact: true })).toBeChecked();
    const selector = projects.getByRole("radio", { name: projectName, exact: true });
    await selector.check();
    if ((await page.locator("html").getAttribute("data-theme")) !== "light")
      await page.getByRole("button", { name: "Use light theme", exact: true }).click();
    await selector.scrollIntoViewIfNeeded();
    await page.screenshot({ path: "output/playwright/setup-project-light.png", fullPage: true });
    expect((await new AxeBuilder({ page }).setLegacyMode().analyze()).violations).toEqual([]);
    await page.getByRole("button", { name: "Use dark theme", exact: true }).click();
    await page.screenshot({ path: "output/playwright/setup-project-dark.png", fullPage: true });
    expect((await new AxeBuilder({ page }).setLegacyMode().analyze()).violations).toEqual([]);
    await page.setViewportSize({ width: 660, height: 900 });
    await selector.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: "output/playwright/setup-project-narrow-dark.png",
      fullPage: true,
    });
    await expect(selector).toBeChecked();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole("button", { name: "Open chat", exact: true }).click();
    await expect(
      page.getByRole("textbox", { name: "Message Fixture coding tool", exact: true }),
    ).toBeFocused();
    await showConversationDetails(page);
    await expect(
      page.getByRole("region", { name: "Conversation workspace", exact: true }),
    ).toContainText("project");
    await page.screenshot({ path: "output/playwright/chat-project-dark.png", fullPage: true });
    expect((await new AxeBuilder({ page }).setLegacyMode().analyze()).violations).toEqual([]);
    expect(existsSync(path.join(fixture.dataDir, "reference-native.json"))).toBe(false);
    for (const chosen of [projectId, ""]) {
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole("button", { name: "Coding agents", exact: true }).click();
      await page.getByRole("button", { name: "Open workspace setup", exact: true }).click();
      await page.getByRole("button", { name: "Get started", exact: true }).click();
      await finishSetup(page);
      await page
        .getByRole("radio", { name: chosen ? projectName : "No project", exact: true })
        .check();
      await page.getByRole("button", { name: "Open chat", exact: true }).click();
      await expect(
        page.getByRole("textbox", { name: "Message Fixture coding tool", exact: true }),
      ).toBeFocused();
      const saved = (await rpc(page, "snapshot.get", {})) as typeof state;
      expect(saved.entities.agent).toHaveLength(1);
      expect(saved.entities.thread).toHaveLength(chosen ? 1 : 2);
      expect(saved.entities.thread?.filter((row) => row.projectId === projectId)).toHaveLength(1);
      expect(saved.entities.session ?? []).toHaveLength(0);
    }
    await showConversationDetails(page);
    await expect(
      page.getByRole("region", { name: "Conversation workspace", exact: true }),
    ).toHaveCount(0);
    expect(existsSync(path.join(fixture.dataDir, "reference-native.json"))).toBe(false);
  } finally {
    await fixture.cleanup();
  }
});
