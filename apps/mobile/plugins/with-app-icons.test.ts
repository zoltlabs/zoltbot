import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const expoRequire = createRequire(require.resolve("expo/package.json"));
const pluginsRequire = createRequire(expoRequire.resolve("@expo/config-plugins/package.json"));
const xcode = pluginsRequire("xcode");
const { configureProject, icons } = require("./with-app-icons.cjs");

describe("iOS app icons config plugin", () => {
  it("adds the icon sets and the switcher to the app once", () => {
    const root = mkdtempSync(path.join(tmpdir(), "zolt-icons-"));
    try {
      execFileSync("tar", [
        "-xzf",
        path.join(path.dirname(require.resolve("expo/package.json")), "template.tgz"),
        "-C",
        root,
        "package/ios",
      ]);
      const ios = path.join(root, "package/ios");
      const project = xcode.project(path.join(ios, "HelloWorld.xcodeproj/project.pbxproj"));
      project.parseSync();
      const stale = path.join(ios, "HelloWorld/Images.xcassets/AppIcon-Retired.appiconset");
      mkdirSync(stale, { recursive: true });
      configureProject(project, ios, "HelloWorld");
      const first = project.writeSync();
      configureProject(project, ios, "HelloWorld");
      expect(existsSync(stale)).toBe(false);
      expect(existsSync(path.join(ios, "HelloWorld/Images.xcassets/AppIcon.appiconset"))).toBe(
        true,
      );
      expect(project.writeSync()).toBe(first);
      expect(first).toContain("ASSETCATALOG_COMPILER_INCLUDE_ALL_APPICON_ASSETS = YES");
      for (const name of ["ZoltIcon.swift", "ZoltIconBridge.m"])
        expect(first).toContain(`${name} in Sources`);
      for (const name of Object.keys(icons)) {
        const set = path.join(ios, "HelloWorld/Images.xcassets", `${name}.appiconset`);
        expect(existsSync(path.join(set, "icon.png"))).toBe(true);
        expect(
          JSON.parse(readFileSync(path.join(set, "Contents.json"), "utf8")).images[0].size,
        ).toBe("1024x1024");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
