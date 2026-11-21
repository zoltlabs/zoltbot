import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const expoRequire = createRequire(require.resolve("expo/package.json"));
const pluginsRequire = createRequire(expoRequire.resolve("@expo/config-plugins/package.json"));
const xcode = pluginsRequire("xcode");
const { configureProject } = require("./with-shortcuts.cjs");

describe("iOS Shortcuts config plugin", () => {
  it("adds the App Intents to the app target once", () => {
    const root = mkdtempSync(path.join(tmpdir(), "zolt-intents-"));
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
      configureProject(project, ios);
      const first = project.writeSync();
      configureProject(project, ios);
      expect(project.writeSync()).toBe(first);
      for (const name of ["ZoltIntents.swift", "ZoltShortcuts.swift", "ZoltShortcutsBridge.m"]) {
        expect(first).toContain(`${name} in Sources`);
        expect(existsSync(path.join(ios, "ZoltIntentsNative", name))).toBe(true);
      }
      const objects = project.hash.project.objects;
      const targets = Object.keys(objects.PBXNativeTarget).filter(
        (key) => !key.endsWith("_comment"),
      );
      expect(targets).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
