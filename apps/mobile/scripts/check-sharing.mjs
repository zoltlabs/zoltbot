import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Build only the extension: no signing, pod installation, simulator boot, or app launch.
const mobile = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(path.join(mobile, "package.json"));
const expoRequire = createRequire(require.resolve("expo/package.json"));
const pluginsRequire = createRequire(expoRequire.resolve("@expo/config-plugins/package.json"));
const root = mkdtempSync(path.join(tmpdir(), "zolt-share-check-"));
const sdk = execFileSync("xcrun", ["--sdk", "iphonesimulator", "--show-sdk-path"], {
  encoding: "utf8",
}).trim();
const architecture = process.arch === "arm64" ? "arm64" : "x86_64";
const sources = path.join(mobile, "native/share");
const run = (command, args) =>
  execFileSync(command, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
try {
  const headers = path.join(root, "headers");
  const react = path.join(headers, "React");
  const nativeRoot = path.dirname(require.resolve("react-native/package.json"));
  mkdirSync(react, { recursive: true });
  for (const file of ["RCTBridgeModule.h", "RCTDefines.h", "RCTJSThread.h", "RCTBundleManager.h"]) {
    symlinkSync(path.join(nativeRoot, "React/Base", file), path.join(react, file));
  }
  const deprecation = path.join(headers, "RCTDeprecation");
  mkdirSync(deprecation);
  symlinkSync(
    path.join(
      nativeRoot,
      "ReactApple/Libraries/RCTFoundation/RCTDeprecation/Exported/RCTDeprecation.h",
    ),
    path.join(deprecation, "RCTDeprecation.h"),
  );
  writeFileSync(
    path.join(react, "module.modulemap"),
    'module React { header "RCTBridgeModule.h" export * }\n',
  );
  run("xcrun", [
    "--sdk",
    "iphonesimulator",
    "swiftc",
    "-typecheck",
    "-module-cache-path",
    path.join(root, "swift-cache"),
    "-target",
    `${architecture}-apple-ios16.0-simulator`,
    "-sdk",
    sdk,
    "-I",
    headers,
    path.join(sources, "ShareStore.swift"),
    path.join(sources, "ZoltShare.swift"),
  ]);
  run("xcrun", [
    "--sdk",
    "iphonesimulator",
    "clang",
    "-fsyntax-only",
    "-fmodules",
    `-fmodules-cache-path=${path.join(root, "objc-cache")}`,
    "-fobjc-arc",
    "-target",
    `${architecture}-apple-ios16.0-simulator`,
    "-isysroot",
    sdk,
    "-I",
    headers,
    path.join(sources, "ZoltShareBridge.m"),
  ]);
  run("tar", [
    "-xzf",
    path.join(path.dirname(require.resolve("expo/package.json")), "template.tgz"),
    "-C",
    root,
    "package/ios",
  ]);
  const ios = path.join(root, "package/ios");
  const projectPath = path.join(ios, "HelloWorld.xcodeproj");
  const project = pluginsRequire("xcode").project(path.join(projectPath, "project.pbxproj"));
  project.parseSync();
  require("./plugins/with-bot-sharing.cjs").configureProject(
    project,
    ios,
    JSON.parse(readFileSync(path.join(mobile, "app.json"))).expo,
  );
  writeFileSync(project.filepath, project.writeSync());
  const extension = Object.entries(project.pbxNativeTargetSection()).find(
    ([id, target]) => !id.endsWith("_comment") && target.name === '"ZoltShareExtension"',
  );
  if (!extension) throw new Error("Missing share extension target");
  const schemeFolder = path.join(projectPath, "xcshareddata/xcschemes");
  mkdirSync(schemeFolder, { recursive: true });
  writeFileSync(
    path.join(schemeFolder, "ZoltShareExtension.xcscheme"),
    `<?xml version="1.0" encoding="UTF-8"?>
<Scheme version="1.3"><BuildAction parallelizeBuildables="YES" buildImplicitDependencies="NO"><BuildActionEntries>
<BuildActionEntry buildForRunning="YES" buildForTesting="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES">
<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="${extension[0]}" BuildableName="ZoltShareExtension.appex" BlueprintName="ZoltShareExtension" ReferencedContainer="container:HelloWorld.xcodeproj"/>
</BuildActionEntry></BuildActionEntries></BuildAction></Scheme>`,
  );
  run("xcodebuild", [
    "-project",
    projectPath,
    "-scheme",
    "ZoltShareExtension",
    "-configuration",
    "Debug",
    "-sdk",
    "iphonesimulator",
    "-destination",
    "generic/platform=iOS Simulator",
    "-derivedDataPath",
    path.join(root, "derived"),
    "-quiet",
    "CODE_SIGNING_ALLOWED=NO",
    `ARCHS=${architecture}`,
    `MODULE_CACHE_DIR=${path.join(root, "clang-cache")}`,
    "build",
  ]);
  console.log(
    "Sharing checks passed: Swift bridge, Objective-C exports, generated iOS extension build.",
  );
} catch (error) {
  console.error(error.stderr?.toString() || error.message);
  console.error(error.stdout?.toString() || "");
  process.exitCode = 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
