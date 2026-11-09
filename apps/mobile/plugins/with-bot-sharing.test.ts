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
const { configureProject } = require("./with-bot-sharing.cjs");

describe("iOS bot sharing config plugin", () => {
  it("embeds an extension and shares sources with the host without duplicating targets", () => {
    const root = mkdtempSync(path.join(tmpdir(), "zolt-sharing-"));
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
      const config = {
        version: "0.1.0",
        ios: { bundleIdentifier: "com.example.zolt", buildNumber: "7", appleTeamId: "TEAM123456" },
      };
      configureProject(project, ios, config);
      const first = project.writeSync();
      configureProject(project, ios, config);
      expect(project.writeSync()).toBe(first);
      const objects = project.hash.project.objects;
      const targets = Object.entries(objects.PBXNativeTarget).filter(
        ([key]) => !key.endsWith("_comment"),
      );
      expect(targets).toHaveLength(2);
      const extension = targets.find(
        ([, value]) => (value as { name: string }).name === '"ZoltShareExtension"',
      );
      expect(extension).toBeDefined();
      const host = project.getFirstTarget().firstTarget;
      expect(host.dependencies).toHaveLength(1);
      expect(first).toContain("ZoltShareExtension.appex in Copy Files");
      expect(first).toContain("ShareStore.swift in Sources");
      const sourcePaths = (target: { buildPhases: { value: string }[] }) =>
        target.buildPhases
          .flatMap((phase) => objects.PBXSourcesBuildPhase[phase.value]?.files ?? [])
          .map(
            (file: { value: string }) =>
              objects.PBXFileReference[objects.PBXBuildFile[file.value].fileRef].path,
          );
      expect(sourcePaths(host)).toContain('"ZoltShareNative/ShareStore.swift"');
      expect(sourcePaths(extension?.[1] as { buildPhases: { value: string }[] })).toContain(
        '"ZoltShareNative/ShareStore.swift"',
      );
      const phases = Object.entries(objects.PBXSourcesBuildPhase)
        .filter(([key]) => !key.endsWith("_comment"))
        .flatMap(([, value]) => (value as { files: { value: string }[] }).files);
      // CocoaPods' Ruby xcodeproj rejects a PBXBuildFile reused in multiple source phases.
      expect(new Set(phases.map((file) => file.value)).size).toBe(phases.length);
      const groupChildren = Object.entries(objects.PBXGroup)
        .filter(([key]) => !key.endsWith("_comment"))
        .flatMap(([, value]) => (value as { children: { value: string }[] }).children);
      for (const file of phases)
        expect(
          groupChildren.some((child) => child.value === objects.PBXBuildFile[file.value].fileRef),
        ).toBe(true);
      // Round-trip the serialized result, not only the in-memory object graph.
      writeFileSync(path.join(ios, "HelloWorld.xcodeproj/project.pbxproj"), first);
      const parsed = xcode.project(path.join(ios, "HelloWorld.xcodeproj/project.pbxproj"));
      expect(() => parsed.parseSync()).not.toThrow();
      expect(first).not.toContain("path = undefined");
      expect(first).toContain("APPLICATION_EXTENSION_API_ONLY = YES");
      expect(first).toContain('CURRENT_PROJECT_VERSION = "7"');
      const info = readFileSync(path.join(ios, "ZoltShareNative/Extension-Info.plist"), "utf8");
      expect(info).toContain("INSendMessageIntent");
      expect(info).toContain("NSExtensionActivationSupportsImageWithMaxCount");
      expect(info).not.toContain("TRUEPREDICATE");
      expect(
        readFileSync(path.join(ios, "ZoltShareNative/Extension.entitlements"), "utf8"),
      ).toContain("group.com.example.zolt");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
