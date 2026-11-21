import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { Redactor } from "../../../../packages/daemon/src/logging";
import { PrivateInputGuard } from "../../../../packages/daemon/src/private-input";
import { vaultApi } from "../../../../packages/daemon/src/vault/api";
import { vaultTools } from "../../../../packages/daemon/src/vault/tools";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { memoryKeychain } from "../../../../tools/fakes/src/memory-keychain";
import { axeViolations, COLOR_SCHEMES, settleColorScheme, shellSession } from "../harness";

const PASSWORD = "synthetic-e2e-password-5521";
const SETUP_KEY = "JBSWY3DPEHPK3PXPJBSWY3DP";

function written(root: string): string {
  let text = "";
  for (const name of readdirSync(root)) {
    const file = path.join(root, name);
    text += statSync(file).isDirectory() ? written(file) : readFileSync(file).toString("latin1");
  }
  return text;
}

/** V1: the owner saves a login and a two-step code, shows the password and removes the code. */
test("the vault saves logins and codes without keeping a value outside the keychain", async ({
  page,
}) => {
  const keychain = memoryKeychain();
  const fixture = await compareFixture({ secrets: keychain.secrets });
  const shell = await shellSession(fixture.daemon);
  try {
    await shell.open(page);
    const sidebar = page.getByRole("complementary", { name: "Bot navigation" });
    await sidebar.getByRole("button", { name: "Vault" }).click();
    const vault = page.getByRole("main", { name: "Vault" });
    await expect(vault.getByRole("heading", { name: "No logins yet" })).toBeVisible();
    for (const scheme of COLOR_SCHEMES) {
      await settleColorScheme(page, scheme);
      expect(await axeViolations(page)).toEqual([]);
    }

    await vault.getByRole("button", { name: "Add login" }).click();
    let dialog = page.getByRole("dialog", { name: "Add login" });
    await dialog.getByRole("button", { name: "Save login" }).click();
    await expect(dialog.getByText("Enter a site, like github.com.")).toBeVisible();
    await dialog.getByLabel("Site").fill("https://github.com/login");
    await dialog.getByLabel("Username").fill("octo-sample");
    await dialog.getByLabel("Password").fill(PASSWORD);
    for (const scheme of COLOR_SCHEMES) {
      await settleColorScheme(page, scheme);
      expect(await axeViolations(page)).toEqual([]);
    }
    await dialog.getByRole("button", { name: "Save login" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(vault.getByText("octo-sample · All agents")).toBeVisible();

    await vault.getByRole("button", { name: "Add two-step code" }).click();
    dialog = page.getByRole("dialog", { name: "Add two-step code" });
    await dialog.getByLabel("Site").fill("github.com");
    await dialog.getByLabel("Setup key").fill("123456");
    await dialog.getByRole("button", { name: "Save code" }).click();
    await expect(dialog.getByText("That isn't a setup key.")).toBeVisible();
    await dialog.getByLabel("Setup key").fill(SETUP_KEY);
    await dialog.getByRole("button", { name: "Save code" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(vault.getByText("Two-step code · All agents")).toBeVisible();
    for (const scheme of COLOR_SCHEMES) {
      await settleColorScheme(page, scheme);
      expect(await axeViolations(page)).toEqual([]);
    }

    // Edit shows the stored password only after the Mac's prompt.
    await vault.getByRole("button", { name: "Actions for github.com" }).first().click();
    await page.getByRole("menuitem", { name: "Edit" }).click();
    dialog = page.getByRole("dialog", { name: "Edit login" });
    await expect(dialog.getByLabel("Password")).toHaveValue("");
    await dialog.getByRole("button", { name: "Show" }).click();
    await expect(dialog.getByLabel("Password")).toHaveValue(PASSWORD);
    await dialog.getByRole("button", { name: "Cancel" }).click();

    await vault.getByRole("button", { name: "Actions for github.com" }).last().click();
    await page.getByRole("menuitem", { name: "Remove" }).click();
    const confirm = page.getByRole("alertdialog", { name: 'Remove "github.com"?' });
    await expect(confirm.getByText("Agents can't sign in with it after this.")).toBeVisible();
    await confirm.getByRole("button", { name: "Remove" }).click();
    await expect(vault.getByText("Two-step code · All agents")).toHaveCount(0);
    expect(keychain.items.size).toBe(1);
    expect(shell.errors).toEqual([]);
    // Nothing the daemon wrote holds a value: not the database, its log or vault.json.
    const files = written(fixture.daemon.dataDir);
    expect(files).toContain("vault.save");
    expect(files).not.toContain(PASSWORD);
    expect(files).not.toContain(SETUP_KEY);
  } finally {
    await shell.close();
    await fixture.close();
  }
});

/** V2: an agent asks to sign in with a saved login; the owner allows it once in the chat. */
test("the owner allows an agent's sign-in from its chat, and the page gets the password", async ({
  page,
}) => {
  const keychain = memoryKeychain();
  const fixture = await compareFixture({ secrets: keychain.secrets });
  const store = fixture.daemon.store;
  const privacy = new PrivateInputGuard({ store, publish() {} });
  const vault = vaultApi({
    dataDir: fixture.daemon.dataDir,
    store,
    secrets: keychain.secrets,
    privacy,
    redactor: new Redactor(),
    publish() {},
  });
  const typed: string[] = [];
  const login = "https://github.com/login";
  const fields: Record<string, { type: string; url: string }> = {
    e1: { type: "email", url: login },
    e2: { type: "password", url: login },
  };
  // The daemon broadcasts the stored card; here the test hands it to the Mac's client itself.
  let deliver: (event: unknown) => void = () => {};
  const tools = vaultTools(
    {
      store,
      privacy,
      publish: (events) => {
        for (const event of events) deliver(event);
      },
      async wake() {},
      vault: vault.runtime,
    },
    {
      page: () => ({
        field: async (target) => fields[target] ?? { type: "div", url: login },
        fill: async (list) => {
          for (const { value } of list) typed.push(value);
        },
      }),
    },
  );
  const actor = { agentId: "profile", threadId: "thread", sessionId: "session", turnId: "turn" };
  const fill = () =>
    tools.call({
      actor,
      arguments: { action: "fill", id, password: "e2", username: "e1", submit: true },
      idempotencyKey: "fill",
    });
  const { entry } = (await vault.api("vault.save", {
    kind: "login",
    sites: ["github.com"],
    username: "octo-sample",
    agents: "all",
    value: PASSWORD,
  })) as { entry: { id: string } };
  const id = entry.id;

  const shell = await shellSession(fixture.daemon);
  try {
    await shell.open(page);
    const client = shell.service.client as unknown as { apply(event: unknown): void };
    deliver = (event) => client.apply(event);
    await page
      .getByRole("button", { name: /^Fixture/ })
      .first()
      .click();
    expect(await fill()).toEqual({ status: "waiting_for_owner" });
    // The card waits in the chat that asked.
    const chat = page.getByRole("main", { name: "Conversation" });
    await expect(chat.getByText("Sign in to github.com")).toBeVisible();
    for (const scheme of COLOR_SCHEMES) {
      await settleColorScheme(page, scheme);
      expect(await axeViolations(page)).toEqual([]);
      await page.screenshot({ path: test.info().outputPath(`vault-card-${scheme}.png`) });
    }
    await chat.getByRole("button", { name: "Allow once" }).click();
    await chat.getByRole("button", { name: "Send answer" }).click();
    await expect
      .poll(() => store.record("interaction", `vault-fill:session:${id}:1`)?.resolution)
      .toBeTruthy();
    expect(await fill()).toEqual({ filled: ["username", "password"], submitted: true });
    expect(typed).toEqual(["octo-sample", PASSWORD]);
    // Once means once: the next sign-in asks again.
    expect(await fill()).toEqual({ status: "waiting_for_owner" });
    expect(shell.errors).toEqual([]);
    expect(written(fixture.daemon.dataDir)).not.toContain(PASSWORD);
  } finally {
    await shell.close();
    await fixture.close();
  }
});
