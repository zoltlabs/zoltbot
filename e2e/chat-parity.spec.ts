import { AxeBuilder } from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { launch, showActivity, testUiUrl } from "./desktop.js";

const calls = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { parityCalls: { method: string; params: unknown }[] }).parityCalls,
  );
async function mount(page: Page, theme: string, pending = "") {
  await page.goto(`${testUiUrl}/`);
  const modulePath = `/@fs/${process.cwd()}/e2e/chat-parity-gallery.tsx`;
  await page.evaluate(
    async ({ modulePath, theme, pending }) => {
      const gallery = await import(modulePath);
      gallery.mountChatParity(theme, pending);
    },
    { modulePath, theme, pending },
  );
  await expect(page.getByRole("heading", { name: "Parity review" })).toBeVisible();
}

for (const theme of ["light", "dark"])
  test(`desktop parity tools, to-do, modes, background tasks and rewind in ${theme}`, async () => {
    const fixture = await launch(true);
    const { page } = fixture;
    try {
      await mount(page, theme);
      await showActivity(page);
      const conversation = page.getByRole("region", { name: "Conversation" });
      // Tools render by kind; edits show their diff and counts inline.
      const edit = conversation.getByRole("article", { name: "Tool Editor" });
      await expect(edit.locator(".tool-diff-counts").first()).toContainText("+2");
      await expect(edit.getByText("export const greeting = 'hello';")).toBeVisible();
      const run = conversation.getByRole("article", { name: "Tool Shell" });
      // A failed command opens with its output.
      await expect(run).toContainText("FAIL src/greeting.test.ts");
      await expect(run).not.toContainText("\u001b[31m");
      await run.getByRole("button", { name: /Show \d+ more lines/ }).click();
      await expect(run).toContainText("Tests: 1 failed");
      // Subagent output nests under the agent card instead of the flat timeline.
      const subagent = conversation.getByRole("article", {
        name: "Subagent: Review the test coverage",
      });
      if (
        !(await subagent
          .locator(":scope > details")
          .evaluate((node) => (node as HTMLDetailsElement).open))
      )
        await subagent.locator(":scope > details > summary").click();
      await expect(subagent.getByRole("article", { name: "Tool Reader" })).toBeVisible();
      await expect(subagent).toContainText("Coverage looks complete");
      await expect(conversation.getByRole("article", { name: "Asked a question" })).toContainText(
        "Answered",
      );
      // Only the newest plan is pinned; updates are one-line notes.
      const todo = page.getByRole("region", { name: "To-do list" });
      await expect(todo).toContainText("1/3");
      await expect(conversation.getByRole("article", { name: "To-do update" })).toHaveCount(2);
      expect((await new AxeBuilder({ page }).setLegacyMode().analyze()).violations).toEqual([]);
      await page.screenshot({ path: `output/playwright/chat-parity-${theme}.png`, fullPage: true });

      // Shift+Tab cycles modes without confirmation; widening modes ask first (I13).
      const editor = page.getByRole("textbox", { name: "Message Builder" });
      await editor.focus();
      await page.keyboard.press("Shift+Tab");
      expect((await calls(page)).at(-1)).toMatchObject({
        method: "session.setMode",
        params: { id: "s", mode: "acceptEdits" },
      });
      await page
        .getByRole("combobox", { name: "Permission mode" })
        .selectOption("bypassPermissions");
      const confirm = page.getByRole("dialog", { name: "Switch to Full access?" });
      await expect(confirm).toBeVisible();
      await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
      await confirm.getByRole("button", { name: "Cancel" }).click();
      await expect(page.getByRole("combobox", { name: "Permission mode" })).toHaveValue("default");
      expect((await calls(page)).filter((call) => call.method === "session.setMode")).toHaveLength(
        1,
      );
      await page
        .getByRole("combobox", { name: "Permission mode" })
        .selectOption("bypassPermissions");
      await confirm.getByRole("button", { name: "Switch to Full access" }).click();
      expect((await calls(page)).at(-1)).toMatchObject({
        method: "session.setMode",
        params: { id: "s", mode: "bypassPermissions", confirmed: true },
      });

      // Background tasks list with Stop.
      await page.getByRole("button", { name: /1 background task running/ }).click();
      await page.getByRole("button", { name: "Stop npm run dev" }).click();
      expect((await calls(page)).at(-1)).toMatchObject({
        method: "session.stopBackground",
        params: { id: "s", taskId: "bg1" },
      });

      // Rewind previews with a dry run, then restores and forks only on an explicit choice.
      await page.getByText("Now update the docs").hover();
      await page.getByRole("button", { name: "Rewind to before this message…" }).last().click();
      const rewind = page.getByRole("dialog", { name: "Rewind to before this message" });
      await expect(rewind).toContainText("2 files will be restored");
      expect((await calls(page)).at(-1)).toMatchObject({
        method: "session.rewind",
        params: { turnId: "turn-2", dryRun: true, confirmed: false },
      });
      await expect(rewind.getByRole("button", { name: "Cancel" })).toBeFocused();
      // Forking waits for a daemon handler (BL-011); rewind restores code only.
      await expect(rewind.getByRole("button", { name: /fork/i })).toHaveCount(0);
      await rewind.getByRole("button", { name: "Restore code" }).click();
      await expect(rewind).toHaveCount(0);
      expect((await calls(page)).at(-1)).toMatchObject({
        method: "session.rewind",
        params: { turnId: "turn-2", dryRun: false, confirmed: true },
      });
      expect((await calls(page)).some((call) => call.method === "thread.fork")).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

test("approval offers session labels, diffs and an always-allow rule; plans offer auto-accept", async () => {
  const fixture = await launch(true);
  const { page } = fixture;
  try {
    await mount(page, "dark", "approval");
    const card = page.getByRole("article", { name: "approval from Builder" });
    await card.getByRole("button", { name: "More", exact: true }).click();
    await expect(
      card.getByRole("menuitem", { name: /Allow for session.*Edit\(src\/\*\*\)/ }),
    ).toBeVisible();
    await expect(card.getByRole("region", { name: "Proposed changes" })).toContainText(
      "export const greeting = 'hello';",
    );
    await card.focus();
    await page.keyboard.press("a");
    const rule = card.getByRole("region", { name: "Always allow" });
    await expect(rule).toContainText("Edit: src/**");
    await rule.getByRole("radio", { name: /Workspace: Greeter/ }).check();
    expect((await new AxeBuilder({ page }).setLegacyMode().analyze()).violations).toEqual([]);
    await rule.getByRole("button", { name: "Save rule and allow" }).click();
    const answered = async () =>
      (await calls(page)).filter((call) =>
        ["rule.create", "interaction.answer"].includes(call.method),
      );
    await expect
      .poll(async () => (await answered()).map((call) => call.method))
      .toEqual(["rule.create", "interaction.answer"]);
    const [create, answer] = await answered();
    expect(create?.params).toMatchObject({
      confirmed: true,
      rule: {
        scope: "project",
        scopeId: "proj",
        decision: "allow",
        matcher: { paths: ["src/**"] },
      },
    });
    expect(answer?.params).toMatchObject({ answer: { action: "accept", choice: "allow_once" } });

    await mount(page, "dark", "plan");
    const plan = page.getByRole("article", { name: "plan from Builder" });
    await plan.getByRole("button", { name: "Keep planning" }).click();
    await expect(plan.getByRole("textbox", { name: "Feedback" })).toBeFocused();
    await expect(plan.getByText("Write what should change in Feedback first.")).toBeVisible();
    await plan.getByRole("textbox", { name: "Feedback" }).fill("Mention the CLI flag too.");
    await plan.getByRole("button", { name: /Approve and auto-accept edits/ }).click();
    expect((await calls(page)).at(-1)?.params).toMatchObject({
      answer: {
        action: "accept",
        choice: "allow_accept_edits",
        feedback: "Mention the CLI flag too.",
      },
    });

    await mount(page, "dark", "form");
    const form = page.getByRole("article", { name: "form from Builder" });
    await expect(form.getByRole("button", { name: "Open link" })).toBeVisible();
    await form.getByRole("button", { name: "Accept", exact: true }).click();
    expect((await calls(page)).at(-1)?.params).toMatchObject({
      answer: { action: "accept", answers: { form: { value: {} } } },
    });
  } finally {
    await fixture.cleanup();
  }
});
