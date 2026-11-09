import { createHash } from "node:crypto";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { launch, showActivity } from "./desktop.js";

test("answers duplicate question prompts by item id in one reply", async () => {
  const fixture = await launch("chat"),
    { page } = fixture;
  try {
    await page.getByRole("button", { name: /Chat verification/ }).click();
    const editor = page.getByRole("textbox", { name: "Message Builder" });
    await editor.fill("duplicate_questions");
    await editor.press("Enter");
    await page.getByRole("button", { name: "Needs you", exact: true }).click();
    const reply = page.getByRole("form", { name: "Reply", exact: true });
    const questions = page.getByRole("list", { name: "Questions", exact: true });
    await expect(questions.getByRole("listitem")).toHaveCount(2);
    await reply.getByRole("button", { name: "A", exact: true }).click();
    await reply.getByRole("button", { name: "B", exact: true }).click();
    await expect(reply.getByRole("button", { name: "B", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await reply
      .getByRole("textbox", { name: "Answer to question 2", exact: true })
      .fill("Exact second answer");
    await expect(reply).toContainText("2 of 2 quoted questions answered");
    await page.screenshot({ path: "output/playwright/inbox-question.png", fullPage: true });
    expect((await new AxeBuilder({ page }).setLegacyMode().analyze()).violations).toEqual([]);
    await reply.getByRole("button", { name: /^Send reply/ }).click();
    await expect(questions).toHaveCount(0);
    await page.getByRole("button", { name: "Overview", exact: true }).click();
    await page.getByRole("button", { name: /Chat verification/ }).click();
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    await expect(page.locator(".chat-request")).toContainText("Answered");
    await showActivity(page);
    const tool = page.getByRole("article", { name: "Tool Read", exact: true });
    await tool.locator("summary").click();
    await expect(tool).toContainText("[private tool output omitted]");
    const digest = createHash("sha256")
      .update(JSON.stringify({ q1: { options: ["a", "b"] }, q2: { other: "Exact second answer" } }))
      .digest("hex");
    await expect(page.getByText(`Native answer SHA256: ${digest}`, { exact: true })).toBeVisible();
  } finally {
    await fixture.cleanup();
  }
});

test("validates flat form types and limits and permits declining unsupported schemas", async () => {
  const fixture = await launch("chat"),
    { page } = fixture;
  try {
    await page.getByRole("button", { name: /Chat verification/ }).click();
    const editor = page.getByRole("textbox", { name: "Message Builder" });
    await editor.fill("form");
    await editor.press("Enter");
    await page.getByRole("button", { name: "Needs you", exact: true }).click();
    const card = page.getByRole("article", { name: "form from Builder", exact: true });
    const accept = card.getByRole("button", { name: "Accept form", exact: true });
    await expect(accept).toBeDisabled();
    await card
      .getByRole("textbox", { name: "name (required)", exact: true })
      .fill("Fixture report");
    await card.getByRole("spinbutton", { name: "count (required)", exact: true }).fill("0");
    await card
      .getByRole("combobox", { name: "enabled (required)", exact: true })
      .selectOption("false");
    await expect(accept).toBeDisabled();
    await card.getByRole("spinbutton", { name: "count (required)", exact: true }).fill("1.5");
    await expect(accept).toBeDisabled();
    await card.getByRole("spinbutton", { name: "count (required)", exact: true }).fill("2");
    await expect(accept).toBeEnabled();
    await expect(card.getByRole("combobox", { name: "format", exact: true })).toHaveValue("0");
    expect((await new AxeBuilder({ page }).setLegacyMode().analyze()).violations).toEqual([]);
    await accept.click();
    await expect(card.getByRole("heading", { name: "Answered", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Overview", exact: true }).click();
    await page.getByRole("button", { name: /Chat verification/ }).click();
    await editor.fill("unsupported_form");
    await editor.press("Enter");
    await page.getByRole("button", { name: "Needs you", exact: true }).click();
    await expect(card).toContainText("unsupported constraints");
    await expect(accept).toHaveCount(0);
    await card.getByRole("button", { name: "Decline", exact: true }).click();
    await expect(card.getByRole("heading", { name: "Answered", exact: true })).toBeVisible();
  } finally {
    await fixture.cleanup();
  }
});

test("offers only native approval choices and sends rejection feedback from the Inbox", async () => {
  const fixture = await launch("chat"),
    { page } = fixture;
  try {
    await page.getByRole("button", { name: /Chat verification/ }).click();
    const editor = page.getByRole("textbox", { name: "Message Builder" });
    await editor.fill("approval");
    await editor.press("Enter");
    await page.getByRole("button", { name: "Needs you", exact: true }).click();
    const card = page.getByRole("article", { name: "approval from Builder", exact: true });
    await expect(card.getByRole("button", { name: /^Approve/ })).toBeVisible();
    await expect(card.getByRole("button", { name: /Allow for session/ })).toHaveCount(0);
    await card.getByRole("button", { name: "More", exact: true }).click();
    await card.getByRole("menuitem", { name: /Decline with a reason/ }).focus();
    await page.keyboard.press("r");
    await expect(card.getByRole("textbox", { name: "Feedback", exact: true })).toBeFocused();
    await card
      .getByRole("textbox", { name: "Feedback", exact: true })
      .fill("Please use the workspace fixture instead.");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("radio", { name: "Dark", exact: true }).check();
    await page.getByRole("button", { name: "Needs you", exact: true }).click();
    await card.getByRole("button", { name: "More", exact: true }).click();
    await card.getByRole("menuitem", { name: /Decline with a reason/ }).click();
    await card
      .getByRole("textbox", { name: "Feedback", exact: true })
      .fill("Please use the workspace fixture instead.");
    await page.screenshot({ path: "output/playwright/inbox-approval-dark.png", fullPage: true });
    expect((await new AxeBuilder({ page }).setLegacyMode().analyze()).violations).toEqual([]);
    await card.getByRole("button", { name: /^Decline N$/ }).click();
    await expect(card.getByRole("heading", { name: "Answered", exact: true })).toBeVisible();
    await expect(card).toContainText("Please use the workspace fixture instead.");
  } finally {
    await fixture.cleanup();
  }
});
