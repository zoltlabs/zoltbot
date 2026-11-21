const fs = require("node:fs");
const path = require("node:path");
const { withEntitlementsPlist, withInfoPlist, withXcodeProject } = require("expo/config-plugins");
const { addSource, sourceGroup, unquote } = require("./xcode-sources.cjs");

// P3: the Live Activity. A widget extension draws it; the app starts, updates and ends it and
// writes the top request to an App Group file the extension reads. Pushes carry counts only.

const targetName = "ZoltActivityWidget";
const sourceFolder = "ZoltActivityNative";
const shared = ["ZoltActivityShared.swift"];
const hostOnly = ["ZoltActivity.swift", "ZoltActivityBridge.m"];
const widgetOnly = ["ZoltActivityWidget.swift"];
const quote = (value) => JSON.stringify(value);
const xml = (value) =>
  String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
const plist = (body) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>${body}</dict></plist>\n`;

function configureProject(project, root, config) {
  const bundleId = config.ios.bundleIdentifier;
  const appGroup = `group.${bundleId}`;
  const widgetId = `${bundleId}.ActivityWidget`;
  const folder = path.join(root, sourceFolder);
  fs.mkdirSync(folder, { recursive: true });
  for (const name of [...shared, ...hostOnly, ...widgetOnly])
    fs.copyFileSync(path.join(__dirname, "../native/activity", name), path.join(folder, name));
  fs.writeFileSync(
    path.join(folder, "Widget.entitlements"),
    plist(
      `<key>com.apple.security.application-groups</key><array><string>${xml(appGroup)}</string></array>`,
    ),
  );
  fs.writeFileSync(
    path.join(folder, "Widget-Info.plist"),
    plist(`
    <key>CFBundleDisplayName</key><string>Zoltbot</string>
    <key>CFBundleIdentifier</key><string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
    <key>CFBundleExecutable</key><string>$(EXECUTABLE_NAME)</string>
    <key>CFBundleName</key><string>$(PRODUCT_NAME)</string>
    <key>CFBundlePackageType</key><string>XPC!</string>
    <key>CFBundleShortVersionString</key><string>$(MARKETING_VERSION)</string>
    <key>CFBundleVersion</key><string>$(CURRENT_PROJECT_VERSION)</string>
    <key>ZoltActivityAppGroup</key><string>${xml(appGroup)}</string>
    <key>NSExtension</key><dict>
      <key>NSExtensionPointIdentifier</key><string>com.apple.widgetkit-extension</string>
    </dict>`),
  );

  const host = project.getFirstTarget();
  const group = sourceGroup(project, sourceFolder);
  let widget = Object.entries(project.pbxNativeTargetSection()).find(
    ([key, value]) => !key.endsWith("_comment") && unquote(value.name) === targetName,
  );
  if (!widget) {
    project.hash.project.objects.PBXTargetDependency ??= {};
    project.hash.project.objects.PBXContainerItemProxy ??= {};
    const target = project.addTarget(targetName, "app_extension", sourceFolder, widgetId);
    widget = [target.uuid, target.pbxNativeTarget];
    project.addBuildPhase([], "PBXSourcesBuildPhase", "Sources", target.uuid);
    project.addBuildPhase([], "PBXFrameworksBuildPhase", "Frameworks", target.uuid);
  }
  for (const name of [...shared, ...hostOnly])
    addSource(project, sourceFolder, name, host.uuid, group);
  for (const name of [...shared, ...widgetOnly])
    addSource(project, sourceFolder, name, widget[0], group);
  const configurations = project.pbxXCBuildConfigurationSection();
  const list = project.pbxXCConfigurationList()[widget[1].buildConfigurationList];
  for (const entry of list.buildConfigurations) {
    Object.assign(configurations[entry.value].buildSettings, {
      INFOPLIST_FILE: quote(`${sourceFolder}/Widget-Info.plist`),
      CODE_SIGN_ENTITLEMENTS: quote(`${sourceFolder}/Widget.entitlements`),
      PRODUCT_BUNDLE_IDENTIFIER: quote(widgetId),
      PRODUCT_MODULE_NAME: targetName,
      SWIFT_VERSION: "5.0",
      IPHONEOS_DEPLOYMENT_TARGET: "16.2",
      TARGETED_DEVICE_FAMILY: quote("1"),
      APPLICATION_EXTENSION_API_ONLY: "YES",
      GENERATE_INFOPLIST_FILE: "NO",
      MARKETING_VERSION: quote(config.version ?? "1.0"),
      CURRENT_PROJECT_VERSION: quote(config.ios.buildNumber ?? "1"),
      ...(config.ios.appleTeamId ? { DEVELOPMENT_TEAM: config.ios.appleTeamId } : {}),
    });
  }
  return project;
}

function withLiveActivity(config) {
  const bundleId = config.ios?.bundleIdentifier;
  if (!bundleId || !/^[A-Za-z0-9.-]+$/.test(bundleId))
    throw new Error("Live Activity requires an iOS bundle identifier.");
  const appGroup = `group.${bundleId}`;
  config = withEntitlementsPlist(config, (mod) => {
    const groups = mod.modResults["com.apple.security.application-groups"] ?? [];
    mod.modResults["com.apple.security.application-groups"] = [...new Set([...groups, appGroup])];
    return mod;
  });
  config = withInfoPlist(config, (mod) => {
    mod.modResults.NSSupportsLiveActivities = true;
    mod.modResults.ZoltActivityAppGroup = appGroup;
    return mod;
  });
  config.extra ??= {};
  config.extra.eas ??= {};
  config.extra.eas.build ??= {};
  config.extra.eas.build.experimental ??= {};
  const experimental = config.extra.eas.build.experimental;
  const extensions = experimental.ios?.appExtensions ?? [];
  experimental.ios = {
    ...experimental.ios,
    appExtensions: [
      ...extensions.filter((extension) => extension.targetName !== targetName),
      {
        targetName,
        bundleIdentifier: `${bundleId}.ActivityWidget`,
        entitlements: { "com.apple.security.application-groups": [appGroup] },
      },
    ],
  };
  return withXcodeProject(config, (mod) => {
    configureProject(mod.modResults, mod.modRequest.platformProjectRoot, config);
    return mod;
  });
}
module.exports = withLiveActivity;
module.exports.configureProject = configureProject;
