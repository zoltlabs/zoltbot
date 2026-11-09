import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { fakePhone, startFakeRelay } from "../packages/daemon/src/relay-test-fixture.js";
import { launch } from "./desktop.js";

test("pairs a phone through the relay, serves it and removes it (D124)", async () => {
  const relay = await startFakeRelay();
  const fixture = await launch("devices");
  const { page } = fixture;
  try {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const devices = page.getByRole("region", { name: "Devices", exact: true });
    const pair = devices.getByRole("button", { name: "Pair a phone", exact: true });
    await expect(pair).toBeDisabled();
    await devices.getByLabel("Relay address", { exact: true }).fill(relay.url);
    await devices.getByRole("button", { name: "Save address", exact: true }).click();
    await expect.poll(() => relay.macOnline(), { timeout: 10_000 }).toBe(true);
    await expect(pair).toBeEnabled();

    await pair.click();
    const code = devices.getByRole("img", { name: "Pairing QR code" });
    await expect(code).toBeVisible();
    const url = await devices.locator("[data-pairing-url]").getAttribute("data-pairing-url");
    expect(url).toMatch(/^zoltbot:\/\/pair\?/);
    await page.getByRole("radio", { name: "Light", exact: true }).check();
    expect(
      (await new AxeBuilder({ page }).include(".devices").setLegacyMode().analyze()).violations,
    ).toEqual([]);
    await devices.screenshot({ path: "output/playwright/devices-qr-light.png" });

    const phone = await fakePhone(url ?? "");
    const allow = devices.getByRole("region", { name: "Allow Test iPhone?" });
    await expect(allow).toBeVisible();
    await expect(code).toHaveCount(0);
    await expect(allow.getByRole("status", { name: "Matching code" })).toHaveText(
      `${phone.confirmCode.slice(0, 3)} ${phone.confirmCode.slice(3)}`,
    );
    await page.getByRole("radio", { name: "Dark", exact: true }).check();
    expect(
      (await new AxeBuilder({ page }).include(".devices").setLegacyMode().analyze()).violations,
    ).toEqual([]);
    await devices.screenshot({ path: "output/playwright/devices-pending-dark.png" });
    await allow.getByRole("button", { name: "Allow", exact: true }).click();

    const list = devices.getByRole("list", { name: "Paired phones" });
    await expect(list.getByText("Test iPhone", { exact: true })).toBeVisible();
    await expect(list.getByText("Last seen just now", { exact: true })).toBeVisible();
    const snapshot = (await phone.call("snapshot.get")) as { entities: Record<string, unknown[]> };
    expect(snapshot.entities.device).toHaveLength(1);
    await devices.screenshot({ path: "output/playwright/devices-paired-dark.png" });

    await list.getByRole("button", { name: "Remove", exact: true }).click();
    await list.getByRole("button", { name: "Remove Test iPhone", exact: true }).click();
    await expect(devices.getByText("No phones paired yet.", { exact: true })).toBeVisible();
    await expect.poll(() => phone.open).toBe(false);
    expect(relay.allowed(phone.id)).toBe(false);
  } finally {
    await relay.close();
    await fixture.cleanup();
  }
});
