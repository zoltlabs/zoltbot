import { expect, test } from "@playwright/test";
import { FakeBridgeAdapter } from "../../../../packages/bridges/src/index";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { axeViolations, COLOR_SCHEMES, settleColorScheme, shellSession } from "../harness";

/** Keychain stand-in: the daemon only ever sees an opaque reference. */
function memoryVault() {
  const values = new Map<string, unknown>();
  return {
    put: async (value: unknown) => {
      const reference = `keychain:zoltbot:00000000-0000-4000-8000-${String(values.size + 1).padStart(12, "0")}`;
      values.set(reference, value);
      return { reference };
    },
    read: async (reference: string) => values.get(reference),
    remove: async (reference: string) => {
      values.delete(reference);
    },
  };
}

test("Bridges shows a bridge's status and lets the owner allow someone who wrote", async ({
  page,
}) => {
  const fake = new FakeBridgeAdapter("Acme workspace");
  const fixture = await compareFixture({
    secrets: memoryVault(),
    bridges: { adapters: { slack: () => fake } },
  });
  const shell = await shellSession(fixture.daemon);
  try {
    const chat = await shell.service.createBot({ profileId: "profile", title: "Support desk" });
    await shell.rpc.call(
      "bridge.save",
      {
        bridge: {
          id: "bridge-1",
          kind: "slack",
          label: "Slack",
          enabled: true,
          routes: [
            {
              id: "route-1",
              from: { id: "C1", label: "#support" },
              to: { kind: "chat", threadId: chat.threadId },
              allow: [],
            },
          ],
        },
        credentials: { botToken: "xoxb-test", appToken: "xapp-test" },
      },
      "save-bridge",
    );
    await expect.poll(() => fake.started).toBe(1);
    fake.deliver({
      id: "m1",
      place: { id: "C1", label: "#support", direct: false },
      sender: { id: "U9", name: "Sam Lee" },
      text: "hi",
      reply: { channel: "C1" },
    });

    await shell.open(page);
    await page.getByRole("button", { name: "Open account menu" }).click();
    await page.getByRole("menuitem", { name: "Bridges" }).click();
    const dialog = page.getByRole("dialog", { name: "Bridges" });
    const row = dialog.getByRole("button", { name: /Slack/ });
    await expect(row).toContainText("Connected");
    await expect(row).toContainText("Acme workspace");
    for (const scheme of COLOR_SCHEMES) {
      await settleColorScheme(page, scheme);
      expect(await axeViolations(page)).toEqual([]);
      const shots = process.env.ZOLTBOT_SHOTS;
      if (shots) await page.screenshot({ path: `${shots}/i1-list-${scheme}.png` });
    }

    await row.click();
    const detail = page.getByRole("dialog", { name: "Slack" });
    await expect(detail.getByText("#support → Support desk")).toBeVisible();
    await expect(detail.getByRole("heading", { name: "Not on the list" })).toBeVisible();
    for (const scheme of COLOR_SCHEMES) {
      await settleColorScheme(page, scheme);
      expect(await axeViolations(page)).toEqual([]);
      const shots = process.env.ZOLTBOT_SHOTS;
      if (shots) await page.screenshot({ path: `${shots}/i1-bridge-${scheme}.png` });
    }
    await detail.getByRole("button", { name: "Allow Sam Lee" }).click();
    await expect(detail.getByRole("heading", { name: "Not on the list" })).toHaveCount(0);
    await expect(detail.getByText("1 person")).toBeVisible();

    await detail.getByRole("button", { name: "Edit route from #support" }).click();
    const editor = page.getByRole("dialog", { name: "Edit route" });
    await expect(editor.getByRole("group", { name: "Who can message" })).toContainText("Sam Lee");
    for (const scheme of COLOR_SCHEMES) {
      await settleColorScheme(page, scheme);
      expect(await axeViolations(page)).toEqual([]);
      const shots = process.env.ZOLTBOT_SHOTS;
      if (shots) await page.screenshot({ path: `${shots}/i1-route-${scheme}.png` });
    }
    await editor.getByLabel("Add by ID").fill("U77");
    await editor.getByRole("button", { name: "Add", exact: true }).click();
    await editor.getByRole("button", { name: "Save route" }).click();
    await expect(page.getByRole("dialog", { name: "Slack" }).getByText("2 people")).toBeVisible();
    const saved = fixture.daemon.store.record("settings", "bridge.record.bridge-1")?.value as {
      routes: { allow: { id: string }[] }[];
      credentialRef: string;
    };
    expect(saved.routes[0]?.allow.map((person) => person.id)).toEqual(["U9", "U77"]);
    expect(JSON.stringify(saved)).not.toContain("xoxb-test");
    expect(shell.errors).toEqual([]);
  } finally {
    await shell.close();
    await fixture.close();
  }
});

test("Adding Slack walks through the manifest and tokens, and keeps the tokens in the Keychain", async ({
  page,
}) => {
  const fake = new FakeBridgeAdapter("Acme workspace");
  const vault = memoryVault();
  let credentials: Record<string, string> = {};
  const fixture = await compareFixture({
    secrets: vault,
    bridges: {
      adapters: {
        slack: (input) => {
          credentials = input.credentials;
          return fake;
        },
      },
    },
  });
  const shell = await shellSession(fixture.daemon);
  try {
    await shell.service.createBot({ profileId: "profile", title: "Support desk" });
    await shell.open(page);
    await page.getByRole("button", { name: "Open account menu" }).click();
    await page.getByRole("menuitem", { name: "Bridges" }).click();
    const dialog = page.getByRole("dialog", { name: "Bridges" });
    await expect(dialog.getByText("No bridges")).toBeVisible();
    await dialog.getByRole("button", { name: "Add bridge" }).click();
    await dialog.getByRole("button", { name: "Slack" }).click();

    const setup = page.getByRole("dialog", { name: "Add Slack" });
    await expect(setup.getByRole("button", { name: "Copy manifest" })).toBeVisible();
    for (const scheme of COLOR_SCHEMES) {
      await settleColorScheme(page, scheme);
      expect(await axeViolations(page)).toEqual([]);
      const shots = process.env.ZOLTBOT_SHOTS;
      if (shots) await page.screenshot({ path: `${shots}/i2-setup-${scheme}.png` });
    }
    await setup.getByLabel("App-level token").fill("xapp-test");
    await setup.getByLabel("Bot token").fill("xoxb-test");
    await setup.getByRole("button", { name: /Choose who answers/ }).click();
    await page.getByRole("option", { name: "Support desk" }).click();
    await setup.getByRole("button", { name: "Add bridge" }).click();

    const detail = page.getByRole("dialog", { name: "Slack" });
    await expect(detail.getByText("Connected")).toBeVisible();
    await expect(detail.getByText("Direct messages → Support desk")).toBeVisible();
    expect(credentials).toEqual({ appToken: "xapp-test", botToken: "xoxb-test" });
    const views = ((await shell.rpc.call("bridge.list", {})) as { items: { bridge: { id: string } }[] }).items;
    const saved = fixture.daemon.store.record("settings", `bridge.record.${views[0]?.bridge.id}`);
    expect(saved).toBeTruthy();
    expect(JSON.stringify([views, saved])).not.toContain("xoxb-test");
    expect(shell.errors).toEqual([]);
  } finally {
    await shell.close();
    await fixture.close();
  }
});

test("Telegram shows a pairing code until the owner sends it from their account", async ({
  page,
}) => {
  const fake = new FakeBridgeAdapter("@zolt_bot");
  const fixture = await compareFixture({
    secrets: memoryVault(),
    bridges: { adapters: { telegram: () => fake } },
  });
  const shell = await shellSession(fixture.daemon);
  try {
    await shell.open(page);
    await page.getByRole("button", { name: "Open account menu" }).click();
    await page.getByRole("menuitem", { name: "Bridges" }).click();
    const dialog = page.getByRole("dialog", { name: "Bridges" });
    await dialog.getByRole("button", { name: "Add bridge" }).click();
    await dialog.getByRole("button", { name: "Telegram" }).click();
    const setup = page.getByRole("dialog", { name: "Add Telegram" });
    await setup.getByLabel("Bot token").fill("123456:test");
    await setup.getByRole("button", { name: "Add bridge" }).click();

    const detail = page.getByRole("dialog", { name: "Telegram" });
    await expect(detail.getByRole("heading", { name: "Pair your account" })).toBeVisible();
    await expect(detail.getByText("send this to @zolt_bot")).toBeVisible();
    const command = (await detail.locator(".bridge-code").innerText()).trim();
    expect(command).toMatch(/^\/start [A-Z2-9]{6}$/);
    for (const scheme of COLOR_SCHEMES) {
      await settleColorScheme(page, scheme);
      expect(await axeViolations(page)).toEqual([]);
      const shots = process.env.ZOLTBOT_SHOTS;
      if (shots) await page.screenshot({ path: `${shots}/i3-pairing-${scheme}.png` });
    }

    fake.deliver({
      id: "1",
      place: { id: "7", label: "", direct: true },
      sender: { id: "7", name: "Sam Lee" },
      text: command,
      reply: { chat: 7 },
    });
    await expect(detail.getByRole("heading", { name: "Pair your account" })).toHaveCount(0);
    await expect(detail.getByText("1 person")).toBeVisible();
    expect(fake.sent.at(-1)?.message.text).toMatch(/^Paired/);
    expect(shell.errors).toEqual([]);
  } finally {
    await shell.close();
    await fixture.close();
  }
});

test("Adding Discord lists the invite permissions and connects with the bot token", async ({
  page,
}) => {
  const fake = new FakeBridgeAdapter("zolt");
  let credentials: Record<string, string> = {};
  const fixture = await compareFixture({
    secrets: memoryVault(),
    bridges: {
      adapters: {
        discord: (input) => {
          credentials = input.credentials;
          return fake;
        },
      },
    },
  });
  const shell = await shellSession(fixture.daemon);
  try {
    await shell.open(page);
    await page.getByRole("button", { name: "Open account menu" }).click();
    await page.getByRole("menuitem", { name: "Bridges" }).click();
    const dialog = page.getByRole("dialog", { name: "Bridges" });
    await dialog.getByRole("button", { name: "Add bridge" }).click();
    await dialog.getByRole("button", { name: "Discord" }).click();
    const setup = page.getByRole("dialog", { name: "Add Discord" });
    await expect(setup.getByText(/Read Message History/)).toBeVisible();
    for (const scheme of COLOR_SCHEMES) {
      await settleColorScheme(page, scheme);
      expect(await axeViolations(page)).toEqual([]);
      const shots = process.env.ZOLTBOT_SHOTS;
      if (shots) await page.screenshot({ path: `${shots}/i4-setup-${scheme}.png` });
    }
    await setup.getByLabel("Bot token").fill("discord-test-token");
    await setup.getByRole("button", { name: "Add bridge" }).click();
    const detail = page.getByRole("dialog", { name: "Discord" });
    await expect(detail.getByText("Connected")).toBeVisible();
    expect(credentials).toEqual({ token: "discord-test-token" });
    expect(shell.errors).toEqual([]);
  } finally {
    await shell.close();
    await fixture.close();
  }
});
