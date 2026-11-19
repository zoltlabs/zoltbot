import { expect, test } from "@playwright/test";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import type { AgentEvent } from "../../src/shared/ipc";
import type {
  BackupOrdersView,
  ModelAccountView,
  ModelsDesktopApi,
  SetBackupOrderInput,
} from "../../src/shared/models";
import { axeViolations, shellSession } from "../harness";

/** Synthetic sign-ins: the fixture daemon has no real coding tools, so none are signed in to. */
function fakeAccounts(): ModelsDesktopApi & { orders: BackupOrdersView } {
  const resets = new Date(Date.now() + 60 * 60_000).toISOString();
  const account = (id: string, name: string, extra: Partial<ModelAccountView> = {}) => ({
    id,
    name,
    label: name,
    definitionId: id.startsWith("codex") ? "codex" : "claude",
    providerName: id.startsWith("codex") ? "Codex" : "Claude",
    isDefault: !name.includes("·"),
    login: "signed_in" as const,
    limitResetsAt: null,
    atLimit: false,
    inUse: 0,
    ...extra,
  });
  const accounts: ModelAccountView[] = [
    account("claude", "Claude", { limitResetsAt: resets, atLimit: true }),
    account("codex", "Codex"),
    account("claude-work", "Claude · Work", { inUse: 1 }),
  ];
  const fake = {
    orders: {
      employee: [{ accountId: "claude" }, { accountId: "claude-work" }],
      manager: null,
      ceo: null,
    } as BackupOrdersView,
    read: async () => ({ accounts, orders: fake.orders }),
    async addAccount(input: { definitionId: string; label: string }) {
      const added = account(`${input.definitionId}-${accounts.length}`, `Claude · ${input.label}`);
      accounts.push(added);
      return {
        account: added,
        signIn: {
          command: "env CLAUDE_CONFIG_DIR=/example/folder claude auth login",
          configDirectory: "/example/folder",
        },
      };
    },
    signIn: async () => ({ command: "claude auth login", configDirectory: "/example/folder" }),
    check: async (id: string) => accounts.find((row) => row.id === id) as ModelAccountView,
    remove: async () => undefined,
    async setOrder(input: SetBackupOrderInput) {
      if (input.role === "employee") fake.orders.employee = input.entries ?? [];
      else fake.orders[input.role] = input.entries;
      return fake.orders;
    },
  };
  return fake;
}

test("models settings and the switch to another provider stay usable", async ({ page }) => {
  const fixture = await compareFixture();
  const shell = await shellSession(fixture.daemon);
  try {
    const fake = fakeAccounts();
    Object.assign(shell.service.accounts, fake);
    const bot = await shell.service.createBot({ profileId: "profile" });
    await shell.service.updateBot({ botId: bot.id, name: "Mira" });
    await shell.open(page);

    await page.getByRole("button", { name: "Models", exact: true }).click();
    const models = page.getByRole("main", { name: "Models" });
    await expect(models.getByLabel("Accounts").getByText("Claude · Work")).toBeVisible();
    await expect(models.getByText("At limit")).toBeVisible();
    await expect(models.getByText("In use")).toBeVisible();
    await expect(models.getByRole("heading", { name: "Backup order for employees" })).toBeVisible();

    // Reorder: move the work account first.
    await models.getByRole("button", { name: "Move Claude · Work up" }).click();
    await expect
      .poll(() => fake.orders.employee.map((entry) => entry.accountId))
      .toEqual(["claude-work", "claude"]);

    // Add Codex as a backup.
    await models.getByRole("combobox", { name: "Account to add" }).selectOption("codex");
    await models.getByRole("button", { name: "Add to order" }).click();
    await expect(models.getByText("Default model · another provider")).toBeVisible();

    // Managers follow employees until they get their own order.
    await models.getByText("Managers", { exact: true }).click();
    await expect(models.getByRole("heading", { name: "Backup order for managers" })).toBeVisible();
    await models.getByRole("button", { name: "Use own order" }).click();
    await expect.poll(() => fake.orders.manager?.length).toBe(3);

    // A new account shows its sign-in command.
    await models.getByRole("button", { name: "Add account" }).click();
    await models.getByRole("textbox", { name: "Name" }).fill("Personal");
    await models.getByRole("button", { name: "Add", exact: true }).click();
    await expect(
      models.getByText("Run this in Terminal to sign in to Claude · Personal:"),
    ).toBeVisible();

    // The running-task limit is saved to the real daemon; values outside 1 to 20 aren't.
    const limit = models.getByRole("spinbutton", { name: "Tasks each employee runs at once" });
    await expect(limit).toHaveValue("2");
    const save = models.getByRole("button", { name: "Save", exact: true });
    await expect(save).toBeDisabled();
    await limit.fill("25");
    await expect(models.getByText("Enter a whole number from 1 to 20.")).toBeVisible();
    await expect(limit).toHaveAttribute("aria-invalid", "true");
    await expect(save).toBeDisabled();
    await limit.fill("4");
    await save.click();
    await expect
      .poll(() => fixture.daemon.store.record("settings", "tasks.runningLimit")?.value)
      .toBe(4);
    await expect(save).toBeDisabled();
    expect(await axeViolations(page)).toEqual([]);
    await page.screenshot({ path: test.info().outputPath("models.png") });

    // Back in the chat: a switch notice and the one-time ask before moving to Codex.
    await page.getByRole("button", { name: /Mira/ }).first().click();
    await expect(page.getByRole("main", { name: "Models" })).toHaveCount(0);
    const answers: unknown[] = [];
    shell.service.respondToPrompt = async (input) => {
      answers.push(input.answers);
      shell.service.emit("event", { type: "prompt-cleared", botId: bot.id } satisfies AgentEvent);
    };
    const now = new Date().toISOString();
    shell.service.emit("event", {
      type: "conversation",
      snapshot: {
        botId: bot.id,
        threadId: bot.id,
        activeTurnId: null,
        revision: 1_000_000,
        messages: [
          {
            id: "notice",
            author: "assistant",
            source: "system",
            itemType: "modelSwitch",
            text: "Claude · Work hit its limit. Continuing on Claude · Personal until 3:40 PM.",
            createdAt: now,
            status: "completed",
          },
        ],
      },
    } satisfies AgentEvent);
    shell.service.emit("event", {
      type: "prompt",
      requestId: "backup-ask",
      botId: bot.id,
      threadId: bot.id,
      turnId: "",
      questions: [
        {
          id: "choice",
          header: "Provider",
          question: "",
          isSecret: false,
          options: [
            { label: "Continue on Codex", description: "" },
            { label: "Wait for the limit to reset", description: "" },
          ],
        },
        {
          id: "remember",
          header: "Next time",
          question: "",
          isSecret: false,
          options: [
            { label: "Don't ask again", description: "" },
            { label: "Ask next time", description: "" },
          ],
        },
      ],
      switchDialog: {
        from: "Claude · Personal",
        to: "Codex",
        provider: "Codex",
        until: "3:40 PM",
        project: "Acme app",
      },
    } satisfies AgentEvent);
    await expect(
      page.getByText("Claude · Work hit its limit. Continuing on Claude · Personal until 3:40 PM."),
    ).toBeVisible();
    const dialog = page.getByRole("dialog", { name: "Continue on Codex?" });
    await expect(dialog.getByRole("button", { name: "Wait until 3:40 PM" })).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
    await page.screenshot({ path: test.info().outputPath("switch-dialog.png") });
    await dialog.getByRole("checkbox", { name: "Don't ask again for Acme app" }).check();
    await dialog.getByRole("button", { name: "Continue on Codex" }).click();
    await expect(dialog).toHaveCount(0);
    expect(answers).toEqual([{ choice: ["Continue on Codex"], remember: ["Don't ask again"] }]);
    expect(shell.errors).toEqual([]);
  } finally {
    await shell.close();
    await fixture.close();
  }
});
