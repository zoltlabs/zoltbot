import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const expoRequire = createRequire(require.resolve("expo/package.json"));
const { AndroidConfig } = expoRequire("@expo/config-plugins");
const {
  configureManifest,
  configureMainApplication,
  copySources,
} = require("./with-android-share.cjs");

describe("Android share target config plugin", () => {
  it("adds the share filters, the package and the sources once", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "zolt-share-"));
    try {
      execFileSync("tar", [
        "-xzf",
        path.join(path.dirname(require.resolve("expo/package.json")), "template.tgz"),
        "-C",
        root,
        "package/android",
      ]);
      const android = path.join(root, "package/android");
      const main = path.join(android, "app/src/main");
      const manifest = await AndroidConfig.Manifest.readAndroidManifestAsync(
        path.join(main, "AndroidManifest.xml"),
      );
      configureManifest(manifest);
      const once = JSON.stringify(manifest);
      configureManifest(manifest);
      expect(JSON.stringify(manifest)).toBe(once);
      const filters = AndroidConfig.Manifest.getMainActivityOrThrow(manifest)["intent-filter"];
      const actions = filters.map(
        (f: { action: { $: Record<string, string> }[] }) => f.action[0]?.$["android:name"],
      );
      expect(actions).toEqual([
        "android.intent.action.MAIN",
        "android.intent.action.SEND",
        "android.intent.action.SEND_MULTIPLE",
      ]);
      expect(once).toContain("image/*");
      expect(once).toContain("text/plain");

      const kotlin = readFileSync(
        path.join(main, "java/com/helloworld/MainApplication.kt"),
        "utf8",
      );
      const registered = configureMainApplication(kotlin);
      expect(configureMainApplication(registered)).toBe(registered);
      expect(registered).toMatch(
        /PackageList\(this\)\.packages\.apply \{\n\s+add\(ai\.zoltbot\.share\.ZoltSharePackage\(\)\)/,
      );
      expect(() => configureMainApplication("class MainApplication")).toThrow();

      copySources(android);
      for (const name of ["ZoltShareModule.kt", "ZoltSharePackage.kt"])
        expect(existsSync(path.join(main, "java/ai/zoltbot/share", name))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
