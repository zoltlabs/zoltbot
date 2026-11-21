import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const expoRequire = createRequire(require.resolve("expo/package.json"));
const pluginsRequire = createRequire(expoRequire.resolve("@expo/config-plugins/package.json"));
const xcode = pluginsRequire("xcode");
const sharing = require("./with-bot-sharing.cjs");
const activity = require("./with-live-activity.cjs");

type Target = { name: string; buildPhases: { value: string }[] };

describe("iOS Live Activity config plugin", () => {
  it("adds a widget extension beside the share extension, once", () => {
    const root = mkdtempSync(path.join(tmpdir(), "zolt-activity-"));
    try {
      execFileSync("tar", [
        "-xzf",
        path.join(path.dirname(require.resolve("expo/package.json")), "template.tgz"),
        "-C",
        root,
        "package/ios",
      ]);
      const ios = path.join(root, "package/ios");
      const file = path.join(ios, "HelloWorld.xcodeproj/project.pbxproj");
      const project = xcode.project(file);
      project.parseSync();
      const config = {
        version: "0.1.0",
        ios: { bundleIdentifier: "com.example.zolt", buildNumber: "7" },
      };
      sharing.configureProject(project, ios, config);
      activity.configureProject(project, ios, config);
      const first = project.writeSync();
      activity.configureProject(project, ios, config);
      expect(project.writeSync()).toBe(first);

      const objects = project.hash.project.objects;
      const targets = Object.entries(objects.PBXNativeTarget)
        .filter(([key]) => !key.endsWith("_comment"))
        .map(([, value]) => value as Target);
      expect(targets.map((target) => target.name).sort()).toEqual([
        '"ZoltActivityWidget"',
        '"ZoltShareExtension"',
        "HelloWorld",
      ]);
      expect(first).toContain("ZoltActivityWidget.appex in Copy Files");
      expect(first).toContain("ZoltShareExtension.appex in Copy Files");
      const sources = (target: Target) =>
        target.buildPhases
          .flatMap((phase) => objects.PBXSourcesBuildPhase[phase.value]?.files ?? [])
          .map(
            (entry: { value: string }) =>
              objects.PBXFileReference[objects.PBXBuildFile[entry.value].fileRef].path,
          );
      const widget = targets.find((target) => target.name === '"ZoltActivityWidget"') as Target;
      const host = project.getFirstTarget().firstTarget as Target;
      expect(sources(widget)).toEqual(
        expect.arrayContaining([
          '"ZoltActivityNative/ZoltActivityShared.swift"',
          '"ZoltActivityNative/ZoltActivityWidget.swift"',
        ]),
      );
      expect(sources(widget)).not.toContain('"ZoltActivityNative/ZoltActivity.swift"');
      expect(sources(host)).toEqual(
        expect.arrayContaining([
          '"ZoltActivityNative/ZoltActivityShared.swift"',
          '"ZoltActivityNative/ZoltActivity.swift"',
        ]),
      );
      expect(sources(host)).not.toContain('"ZoltActivityNative/ZoltActivityWidget.swift"');
      const phases = Object.entries(objects.PBXSourcesBuildPhase)
        .filter(([key]) => !key.endsWith("_comment"))
        .flatMap(([, value]) => (value as { files: { value: string }[] }).files);
      expect(new Set(phases.map((entry) => entry.value)).size).toBe(phases.length);
      expect(first).toContain("IPHONEOS_DEPLOYMENT_TARGET = 16.2");
      writeFileSync(file, first);
      expect(() => xcode.project(file).parseSync()).not.toThrow();
      const info = readFileSync(path.join(ios, "ZoltActivityNative/Widget-Info.plist"), "utf8");
      expect(info).toContain("com.apple.widgetkit-extension");
      expect(info).toContain("group.com.example.zolt");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
