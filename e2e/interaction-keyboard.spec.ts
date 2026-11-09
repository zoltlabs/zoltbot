import { expect, test } from "@playwright/test";
import { launch } from "./desktop.js";

test("uses number selection, Other, defer, skip, session approval, and plan comments from chat", async () => {
  const fixture = await launch("chat"),
    { page } = fixture;
  try {
    await page.getByRole("button", { name: /Chat verification/ }).click();
    const editor = page.getByRole("textbox", { name: "Message Builder" });
    const ask = async (text: string) => {
      // This scenario asks sequential questions; an answered card can disappear before native idle.
      await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
      await editor.fill(text);
      await editor.press("Enter");
    };
    const question = page
      .getByRole("region", { name: "Pending request", exact: true })
      .getByRole("article", { name: "question from Builder", exact: true });
    await ask("single_question");
    await expect(question.getByRole("radio", { name: "A Recommended", exact: true })).toBeFocused();
    await page.keyboard.press("2");
    await expect(question.getByRole("radio", { name: "B", exact: true })).toBeChecked();
    await expect(question).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(question).toHaveCount(0);
    await expect(editor).toBeFocused();
    await ask("single_question");
    await expect(question.getByRole("radio", { name: "A Recommended", exact: true })).toBeFocused();
    await page.keyboard.press("o");
    const other = question.getByRole("textbox", { name: "Other", exact: true });
    await expect(other).toBeFocused();
    await other.fill("A different color");
    await other.press("Enter");
    await expect(question).toHaveCount(0);
    await expect(editor).toBeFocused();
    await ask("single_question");
    await expect(question.getByRole("radio", { name: "A Recommended", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(question).toHaveCount(0);
    await expect(editor).toBeFocused();
    await page.getByRole("button", { name: "Open 1 pending request", exact: true }).click();
    await expect(question.getByRole("radio", { name: "A Recommended", exact: true })).toBeFocused();
    await page.keyboard.press("s");
    await expect(question).toHaveCount(0);
    await expect(editor).toBeFocused();
    await ask("approval_session");
    const approval = page
      .getByRole("region", { name: "Pending request", exact: true })
      .getByRole("article", { name: "approval from Builder", exact: true });
    await expect(approval).toBeFocused();
    await expect(approval.getByRole("button", { name: "More", exact: true })).toBeVisible();
    await page.keyboard.press("s");
    await expect(approval).toHaveCount(0);
    await expect(editor).toBeFocused();
    await ask("approval");
    await expect(approval).toBeFocused();
    await page.keyboard.press("y");
    await expect(approval).toHaveCount(0);
    await expect(editor).toBeFocused();
    await ask("approval");
    await expect(approval).toBeFocused();
    await page.keyboard.press("n");
    await expect(approval).toHaveCount(0);
    await expect(editor).toBeFocused();
    await ask("plan");
    const plan = page
      .getByRole("region", { name: "Pending request", exact: true })
      .getByRole("article", { name: "plan from Builder", exact: true });
    await expect(plan).toBeFocused();
    await page.evaluate(() => {
      const heading = document.querySelector(".chat-pending-request .chat-markdown h1");
      if (!heading) throw new Error("fixture_plan_missing");
      const range = document.createRange();
      range.selectNodeContents(heading);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
    await page.keyboard.press("c");
    const feedback = plan.getByRole("textbox", { name: "Feedback", exact: true });
    await expect(feedback).toBeFocused();
    await expect(feedback).toHaveValue(/Quoted text: Plan/);
    await feedback.fill("Quoted text: Plan\nComment: Clarify rollback.");
    await plan.getByRole("button", { name: "Keep planning", exact: true }).click();
    await expect(plan).toHaveCount(0);
    await expect(editor).toBeFocused();
    await ask("plan");
    await expect(plan).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(plan).toHaveCount(0);
    await expect(editor).toBeFocused();
  } finally {
    await fixture.cleanup();
  }
});

test("navigates pending and ended requests with J and K and defers selected requests durably", async () => {
  const fixture = await launch("chat"),
    { page } = fixture;
  try {
    await page.getByRole("button", { name: /Chat verification/ }).click();
    const editor = page.getByRole("textbox", { name: "Message Builder" });
    await editor.fill("approval");
    await editor.press("Enter");
    const pinned = page
      .getByRole("region", { name: "Pending request", exact: true })
      .getByRole("article", { name: "approval from Builder", exact: true });
    await expect(pinned).toBeFocused();
    await page.keyboard.press("y");
    await expect(editor).toBeFocused();
    await editor.fill("approval");
    await editor.press("Enter");
    await expect(pinned).toBeFocused();
    await page.getByRole("button", { name: "Needs you", exact: true }).click();
    // One row per conversation; the answered approval is not asked again.
    await expect(
      page.getByRole("list", { name: "Conversations", exact: true }).getByRole("listitem"),
    ).toHaveCount(1);
    const card = page.getByRole("article", { name: "approval from Builder", exact: true });
    await expect(card).toHaveCount(1);
    await expect(card.getByRole("button", { name: /^Approve/ })).toBeVisible();
    await page.getByRole("button", { name: "Overview", exact: true }).click();
    await page.getByRole("button", { name: /Chat verification/ }).click();
    await pinned.focus();
    await page.keyboard.press("n");
    await expect(editor).toBeFocused();
  } finally {
    await fixture.cleanup();
  }
});
