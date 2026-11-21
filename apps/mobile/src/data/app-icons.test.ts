import { expect, it } from "vitest";
import { appIconFor, appIcons } from "./app-icons";

it("names the icon iOS reports, falling back to Classic", () => {
  expect(appIconFor(null).id).toBe("classic");
  expect(appIconFor("AppIcon-Amber").id).toBe("amber");
  expect(appIconFor("AppIcon-Retired").id).toBe("classic");
});

it("matches the icon sets the plugin adds", async () => {
  const { icons } = (await import("../../plugins/with-app-icons.cjs")) as {
    icons: Record<string, string>;
  };
  expect(appIcons.flatMap((icon) => (icon.native ? [icon.native] : [])).sort()).toEqual(
    Object.keys(icons).sort(),
  );
});
