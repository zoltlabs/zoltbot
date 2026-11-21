const fs = require("node:fs");
const path = require("node:path");
const { withXcodeProject } = require("expo/config-plugins");
const { addSource, sourceGroup, unquote } = require("./xcode-sources.cjs");

// P7: alternate Home Screen icons. Each becomes an icon set in the app's asset catalog, and Xcode
// lists them for setAlternateIconName; a small native module makes the switch.

const sourceFolder = "ZoltIconNative";
const files = ["ZoltIcon.swift", "ZoltIconBridge.m"];
/** Icon set name → source picture, 1024 px. The main icon stays app.json's `icon`. */
const icons = {
  "AppIcon-Paper": "paper.png",
  "AppIcon-Amber": "amber.png",
  "AppIcon-Mono": "mono.png",
};

function configureProject(project, root, projectName) {
  const assets = path.join(root, projectName, "Images.xcassets");
  if (!fs.existsSync(assets)) throw new Error("App icons need the app's Images.xcassets.");
  // A set dropped from `icons` would still ship, since Xcode includes every icon set.
  for (const entry of fs.readdirSync(assets))
    if (/^AppIcon-.+\.appiconset$/.test(entry) && !(entry.replace(/\.appiconset$/, "") in icons))
      fs.rmSync(path.join(assets, entry), { recursive: true, force: true });
  for (const [name, source] of Object.entries(icons)) {
    const folder = path.join(assets, `${name}.appiconset`);
    fs.mkdirSync(folder, { recursive: true });
    fs.copyFileSync(path.join(__dirname, "../assets/icons", source), path.join(folder, "icon.png"));
    fs.writeFileSync(
      path.join(folder, "Contents.json"),
      `${JSON.stringify(
        {
          images: [
            { filename: "icon.png", idiom: "universal", platform: "ios", size: "1024x1024" },
          ],
          info: { author: "zoltbot", version: 1 },
        },
        null,
        2,
      )}\n`,
    );
  }
  const folder = path.join(root, sourceFolder);
  fs.mkdirSync(folder, { recursive: true });
  for (const name of files)
    fs.copyFileSync(path.join(__dirname, "../native/icons", name), path.join(folder, name));
  const group = sourceGroup(project, sourceFolder);
  const host = project.getFirstTarget();
  for (const name of files) addSource(project, sourceFolder, name, host.uuid, group);
  const configurations = project.pbxXCBuildConfigurationSection();
  const list = project.pbxXCConfigurationList()[host.firstTarget.buildConfigurationList];
  for (const entry of list.buildConfigurations) {
    const settings = configurations[entry.value].buildSettings;
    settings.ASSETCATALOG_COMPILER_INCLUDE_ALL_APPICON_ASSETS = "YES";
    if (!unquote(settings.ASSETCATALOG_COMPILER_APPICON_NAME))
      settings.ASSETCATALOG_COMPILER_APPICON_NAME = "AppIcon";
  }
  return project;
}

function withAppIcons(config) {
  return withXcodeProject(config, (mod) => {
    configureProject(
      mod.modResults,
      mod.modRequest.platformProjectRoot,
      mod.modRequest.projectName,
    );
    return mod;
  });
}
module.exports = withAppIcons;
module.exports.configureProject = configureProject;
module.exports.icons = icons;
