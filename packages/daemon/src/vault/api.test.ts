import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { memoryKeychain } from "../../../../tools/fakes/src/memory-keychain.js";
import { DaemonClient } from "../../../ui/src/connection.js";
import { startDaemon } from "../api.js";

/** Every byte the daemon wrote under its data folder. */
function writtenFiles(root: string): string {
  let text = "";
  for (const name of readdirSync(root)) {
    const file = path.join(root, name);
    if (statSync(file).isDirectory()) text += writtenFiles(file);
    else text += readFileSync(file).toString("latin1");
  }
  return text;
}

const PASSWORD = "synthetic-vault-password-4821";
const NEW_PASSWORD = "synthetic-vault-password-9374";
const SETUP_KEY = "JBSW Y3DP EHPK 3PXP JBSW Y3DP";

it("keeps vault values in the keychain and out of every list, file and log", async () => {
  mkdirSync(".cache/tests", { recursive: true });
  const dataDir = mkdtempSync(path.resolve(".cache/tests/vault-"));
  let present = true;
  const keychain = memoryKeychain({ present: () => present });
  const daemon = await startDaemon({ dataDir, secrets: keychain.secrets });
  const client = new DaemonClient(async () => ({ url: daemon.url, token: daemon.token }));
  try {
    await client.start();
    await expect(client.call("vault.list", {})).resolves.toEqual({ entries: [], available: true });

    const saved = (await client.call(
      "vault.save",
      {
        kind: "login",
        sites: ["https://GitHub.com/login", "github.com"],
        username: " octo-sample ",
        agents: "all",
        value: PASSWORD,
      },
      "vault-save-login",
    )) as { entry: Record<string, unknown> };
    expect(saved.entry).toMatchObject({
      kind: "login",
      label: "github.com",
      sites: ["github.com"],
      username: "octo-sample",
      agents: "all",
    });
    expect(JSON.stringify(saved)).not.toContain(PASSWORD);
    const code = (await client.call(
      "vault.save",
      { kind: "totp", sites: ["github.com"], agents: ["agent-a", "agent-a"], value: SETUP_KEY },
      "vault-save-code",
    )) as { entry: { id: string; agents: string[] } };
    expect(code.entry.agents).toEqual(["agent-a"]);

    await expect(
      client.call(
        "vault.save",
        { kind: "login", sites: ["not a site"], agents: "all", value: PASSWORD },
        "vault-bad-site",
      ),
    ).rejects.toThrow("invalid_site");
    await expect(
      client.call(
        "vault.save",
        { kind: "totp", sites: ["github.com"], agents: "all", value: "123456" },
        "vault-bad-key",
      ),
    ).rejects.toThrow("invalid_setup_key");

    const id = String(saved.entry.id);
    await client.call("vault.update", { id, value: NEW_PASSWORD, agents: [] }, "vault-update");
    await expect(client.call("vault.reveal", { id })).resolves.toEqual({ value: NEW_PASSWORD });
    present = false;
    await expect(client.call("vault.reveal", { id })).rejects.toThrow("reveal_cancelled");
    present = true;

    const listed = (await client.call("vault.list", {})) as { entries: unknown[] };
    expect(listed.entries).toHaveLength(2);
    expect(JSON.stringify(listed)).not.toMatch(/synthetic-vault|JBSW|keychain:zoltbot/);

    await expect(
      client.call("vault.remove", { id: code.entry.id, confirmed: false }, "vault-remove-no"),
    ).rejects.toThrow();
    await client.call("vault.remove", { id: code.entry.id, confirmed: true }, "vault-remove");
    expect(keychain.items.size).toBe(1);

    const audits = (daemon.store.snapshot(["audit"]).audit ?? []).map((row) => row.action);
    expect(audits).toEqual(
      expect.arrayContaining(["vault.save", "vault.update", "vault.reveal", "vault.remove"]),
    );
    // vault.json is private to this user.
    expect(statSync(path.join(dataDir, "vault.json")).mode & 0o777).toBe(0o600);
  } finally {
    client.stop();
    await daemon.close();
  }
  const written = writtenFiles(dataDir);
  for (const value of [PASSWORD, NEW_PASSWORD, "JBSWY3DPEHPK3PXP", SETUP_KEY])
    expect(written).not.toContain(value);
  rmSync(dataDir, { recursive: true, force: true });
});

it("says the vault isn't set up on a daemon without a keychain", async () => {
  mkdirSync(".cache/tests", { recursive: true });
  const dataDir = mkdtempSync(path.resolve(".cache/tests/vault-"));
  const daemon = await startDaemon({ dataDir });
  const client = new DaemonClient(async () => ({ url: daemon.url, token: daemon.token }));
  try {
    await client.start();
    await expect(client.call("vault.list", {})).resolves.toEqual({ entries: [], available: false });
    await expect(
      client.call(
        "vault.save",
        { kind: "login", sites: ["github.com"], agents: "all", value: PASSWORD },
        "vault-unavailable",
      ),
    ).rejects.toThrow("vault_unavailable");
  } finally {
    client.stop();
    await daemon.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

it("keeps a pasted secret and gives the chat a reference in its place (V4)", async () => {
  mkdirSync(".cache/tests", { recursive: true });
  const dataDir = mkdtempSync(path.resolve(".cache/tests/vault-"));
  const keychain = memoryKeychain();
  const daemon = await startDaemon({ dataDir, secrets: keychain.secrets });
  const client = new DaemonClient(async () => ({ url: daemon.url, token: daemon.token }));
  const SECRET = "sk-synthetic-secret-value-0000000000";
  try {
    await client.start();
    const saved = (await client.call(
      "vault.saveSecret",
      { label: "Example [API] key", value: SECRET },
      "vault-save-secret",
    )) as { entry: Record<string, unknown>; reference: string };
    expect(saved.reference).toBe("[vault: Example  API  key]");
    expect(saved.entry).toMatchObject({ kind: "secret", sites: [], agents: "all" });
    expect(JSON.stringify(saved)).not.toContain(SECRET);
    await expect(
      client.call(
        "vault.save",
        { kind: "secret", sites: ["github.com"], agents: "all", value: SECRET },
        "vault-save-secret-2",
      ),
    ).rejects.toThrow("invalid_kind");
    // A second secret with the same name gets its own reference.
    const again = (await client.call(
      "vault.saveSecret",
      { label: "Example [API] key", value: `${SECRET}-2` },
      "vault-save-secret-3",
    )) as { reference: string };
    expect(again.reference).toBe("[vault: Example  API  key 2]");
    const listed = (await client.call("vault.list", {})) as { entries: unknown[] };
    expect(listed.entries).toHaveLength(2);
    expect(writtenFiles(dataDir)).not.toContain(SECRET);
    expect([...keychain.items.values()].join("")).toContain(SECRET);
  } finally {
    client.stop();
    await daemon.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
