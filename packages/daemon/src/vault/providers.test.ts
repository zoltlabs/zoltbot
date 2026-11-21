import { expect, it } from "vitest";
import { fakePasswordManagers } from "../../../../tools/fakes/src/password-managers.js";
import { validItem, vaultProviders } from "./providers.js";

const ITEMS = [
  {
    id: "abcdefghijklmnopqrstuvwxyz",
    title: "GitHub",
    username: "octo-sample",
    password: "synthetic-manager-password-1",
    urls: ["https://github.com/login"],
  },
  {
    id: "zyxwvutsrqponmlkjihgfedcba",
    title: "Example Mail",
    password: "synthetic-manager-password-2",
    urls: ["mail.example.test", "not a url"],
  },
];

function providers(
  installed: Parameters<typeof fakePasswordManagers>[0]["installed"],
  session?: string,
) {
  const fake = fakePasswordManagers({ installed, items: ITEMS, bitwardenSession: "bw-key" });
  return {
    fake,
    providers: vaultProviders({
      ...fake.host,
      cwd: "/",
      session: async () => (session ? { value: session, binary: "/fake/bin/bw:original" } : undefined),
    }),
  };
}

it("lists each manager's state and its logins by title and site only", async () => {
  const { providers: all } = providers({ op: "ready", bw: "locked" });
  expect(await all.list()).toEqual([
    { id: "1password", name: "1Password", state: "ready" },
    { id: "bitwarden", name: "Bitwarden", state: "locked", path: "/fake/bin/bw" },
    { id: "proton", name: "Proton Pass", state: "missing" },
  ]);
  const items = await all.items("1password");
  expect(items).toEqual([
    {
      id: ITEMS[0]?.id,
      title: "GitHub",
      username: "octo-sample",
      sites: ["github.com"],
    },
    { id: ITEMS[1]?.id, title: "Example Mail", sites: ["mail.example.test"] },
  ]);
  expect(JSON.stringify(items)).not.toContain("synthetic-manager-password");
  expect(await all.items("1password", "mail")).toHaveLength(1);
  await expect(all.items("bitwarden")).rejects.toThrow("provider_failed");
});

it("reads a login from each manager's CLI", async () => {
  for (const [installed, id] of [
    [{ op: "ready" }, "1password"],
    [{ bw: "ready" }, "bitwarden"],
    [{ "pass-cli": "ready" }, "proton"],
  ] as const) {
    const { providers: one } = providers(installed);
    expect(await one.read(id, ITEMS[0]?.id ?? "")).toEqual({
      username: "octo-sample",
      password: "synthetic-manager-password-1",
    });
    const listed = await one.items(id);
    expect(listed.map((item) => item.title)).toEqual(["GitHub", "Example Mail"]);
    expect(JSON.stringify(listed)).not.toContain("synthetic-manager-password");
  }
});

it("unlocks Bitwarden with the owner's session key, sent only in its environment", async () => {
  const { providers: locked } = providers({ bw: "locked" });
  expect(await locked.state("bitwarden")).toMatchObject({ state: "locked" });
  const { providers: unlocked, fake } = providers({ bw: "locked" }, "bw-key");
  expect(await unlocked.state("bitwarden")).toMatchObject({ state: "ready" });
  expect(await unlocked.read("bitwarden", ITEMS[1]?.id ?? "")).toEqual({
    password: "synthetic-manager-password-2",
  });
  expect(fake.calls.flat()).not.toContain("bw-key");
});

it("refuses item ids that could read as an option", async () => {
  expect(validItem("--session")).toBe(false);
  expect(validItem("abc def")).toBe(false);
  expect(validItem("5f0c1c1e-0000-4000-8000-000000000000")).toBe(true);
  const { providers: one } = providers({ op: "ready" });
  await expect(one.read("1password", "--reveal")).rejects.toThrow("provider_item_invalid");
});
