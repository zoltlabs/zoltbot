import { expect, test } from "@playwright/test";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import type { DaemonClient } from "../../src/zolt/daemon-client";
import { axeViolations, COLOR_SCHEMES, settleColorScheme, shellSession } from "../harness";

/** Makes the daemon look unreachable to the app, then reachable again. */
function connection(client: DaemonClient) {
  const call = client.call.bind(client);
  const sent: string[] = [];
  let up = true;
  client.call = (method, params, commandId) => {
    if (method === "turn.send") {
      if (!up) return Promise.reject(new Error("Daemon unavailable"));
      sent.push(String(commandId));
    }
    return call(method, params, commandId);
  };
  const announce = (status: DaemonClient["status"]) => {
    client.status = status;
    (client as unknown as { emit(change: { kind: "status" }): void }).emit({ kind: "status" });
  };
  return {
    sent,
    down() {
      up = false;
      announce("offline");
    },
    up() {
      up = true;
      announce("online");
    },
  };
}

test("messages written while Zoltbot is unreachable wait, then send once", async ({ page }) => {
  const fixture = await compareFixture();
  const shell = await shellSession(fixture.daemon);
  const link = connection(shell.service.client);
  try {
    const bot = await shell.service.createBot({ profileId: "profile", title: "Release notes" });
    await shell.open(page);
    await page
      .getByRole("complementary", { name: "Bot navigation" })
      .getByRole("button", { name: /^Release notes/ })
      .click();
    const chat = page.getByLabel("Conversation");
    const composer = page.getByRole("textbox", { name: "Message Release notes" });

    link.down();
    await composer.click();
    await composer.pressSequentially("Draft the changelog");
    await composer.press("Enter");
    await composer.pressSequentially("Then tag the release");
    await composer.press("Enter");
    const first = chat.locator(".message-entry-user", { hasText: "Draft the changelog" });
    const second = chat.locator(".message-entry-user", { hasText: "Then tag the release" });
    await expect(first.getByText("Waiting to send")).toBeVisible();
    await expect(second.getByText("Waiting to send")).toBeVisible();
    for (const scheme of COLOR_SCHEMES) {
      await settleColorScheme(page, scheme);
      expect(await axeViolations(page)).toEqual([]);
    }

    // Send now while still unreachable says so and keeps the message.
    await second.getByRole("button", { name: "Send now" }).click();
    await expect(second.getByRole("alert")).toContainText("isn’t reachable");
    // Delete takes one out.
    await second.getByRole("button", { name: "Delete" }).click();
    await expect(second).toHaveCount(0);
    expect(link.sent).toEqual([]);

    // Once Zoltbot is back the rest sends by itself, once.
    link.up();
    await expect(first.getByText("Waiting to send")).toHaveCount(0);
    await expect(chat.locator(".message-copy", { hasText: "Draft the changelog" })).toHaveCount(1);
    expect(link.sent).toHaveLength(1);

    // The agent got it once.
    const received = () =>
      [...fixture.natives.values()]
        .flatMap((native) => native.received)
        .filter((input) => JSON.stringify(input).includes("Draft the changelog")).length;
    await expect.poll(received).toBe(1);

    // The daemon applies a repeated commandId once, so a resend after a lost reply is safe.
    const send = () =>
      shell.service.client.call(
        "turn.send",
        {
          threadId: bot.id,
          input: [{ type: "text", text: "Once" }],
          mode: "queue",
          outputMode: "auto",
        },
        "outbox-e2e-once",
      ) as Promise<{ id: string }>;
    const [one, two] = [await send(), await send()];
    expect(two.id).toBe(one.id);
    expect(shell.errors).toEqual([]);
  } finally {
    await shell.close();
    await fixture.close();
  }
});
