import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
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
