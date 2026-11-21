import { STARRED_MODELS_SETTING } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { forkFixture } from "../../../tools/fakes/src/fork-fixture.js";
import { PrivateInputGuard } from "./private-input.js";
import { settingsApi } from "./settings-api.js";

it("A8: stores starred models for every device and keeps other models rows reserved", async () => {
  const f = await forkFixture();
  try {
    const settings = settingsApi({
      store: f.store,
      privacy: new PrivateInputGuard({ store: f.store, publish() {} }),
      redactor: { text: (t: string) => t, value: <T>(v: T) => v },
      publish() {},
    } as never);
    await settings(
      "settings.set",
      { key: STARRED_MODELS_SETTING, value: ["opus", "mini:free"] },
      "s1",
    );
    expect(
      f.store.snapshot(["settings"]).settings?.find((row) => row.key === STARRED_MODELS_SETTING)
        ?.value,
    ).toEqual(["opus", "mini:free"]);
    await expect(
      settings("settings.set", { key: STARRED_MODELS_SETTING, value: ["a", "a"] }, "s2"),
    ).rejects.toThrow("invalid_setting");
    await expect(
      settings("settings.set", { key: STARRED_MODELS_SETTING, value: "opus" }, "s3"),
    ).rejects.toThrow("invalid_setting");
    await expect(
      settings("settings.set", { key: "models.orders", value: {} }, "s4"),
    ).rejects.toThrow("setting_reserved");
  } finally {
    f.close();
  }
});
