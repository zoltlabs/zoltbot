import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { launch } from "./desktop.js";

test("masks private answers, persists only protected references, and redacts a later native echo", async () => {
  const fixture = await launch("chat"),
    { page } = fixture;
  const secret = "synthetic-private-resume-answer";
  try {
    await page.getByRole("button", { name: /Chat verification/ }).click();
    const editor = page.getByRole("textbox", { name: "Message Builder" });
    await editor.fill("secret_question");
    await editor.press("Enter");
    const card = page
      .getByRole("region", { name: "Pending request", exact: true })
      .getByRole("article", { name: "question from Builder", exact: true });
    const input = card.getByLabel("Private answer", { exact: true });
    await expect(input).toHaveAttribute("type", "password");
    await expect(input).toHaveAttribute("autocomplete", "off");
    await input.fill(secret);
    await page.screenshot({ path: "output/playwright/chat-private-answer.png", fullPage: true });
    expect((await new AxeBuilder({ page }).setLegacyMode().analyze()).violations).toEqual([]);
    await input.press("Enter");
    await expect(card).toHaveCount(0);
    await expect(editor).toBeFocused();
    await editor.fill("private_echo");
    await editor.press("Enter");
    await expect(page.getByText("Private echo: [redacted]", { exact: true })).toBeVisible();
    await expect(page.getByText(secret, { exact: false })).toHaveCount(0);
    await editor.fill(`Keep this draft ${secret}`);
    await editor.press("Enter");
    await expect(page.getByRole("alert")).toContainText("known private value");
    await expect(editor).toHaveValue(`Keep this draft ${secret}`);
    await editor.fill("single_question");
    await editor.press("Enter");
    await expect(card.getByRole("radio", { name: "A Recommended", exact: true })).toBeFocused();
    await page.keyboard.press("o");
    const publicAnswer = card.getByRole("textbox", { name: "Other", exact: true });
    await publicAnswer.fill(secret);
    await publicAnswer.press("Enter");
    await expect(card.getByRole("alert")).toContainText("masked fields");
    await expect(publicAnswer).toHaveValue(secret);
    await card.getByRole("button", { name: "Skip", exact: true }).click();
    await expect(card).toHaveCount(0);
    await page.getByRole("button", { name: "Needs you", exact: true }).click();
    await expect(page.getByRole("region", { name: "Inbox", exact: true })).toBeVisible();
    await expect(page.getByText(secret, { exact: false })).toHaveCount(0);
    for (const name of [
      "zoltbot.db",
      "zoltbot.db-wal",
      "frames.jsonl",
      "frames.jsonl.1",
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
