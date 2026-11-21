const fs = require("node:fs");
const path = require("node:path");
const { withXcodeProject } = require("expo/config-plugins");
const { addSource, sourceGroup } = require("./xcode-sources.cjs");

// P4: Siri and Shortcuts actions. App Intents in the app target need no extension; they reuse
// the share store (with-bot-sharing) and the Live Activity cache (with-live-activity).

const sourceFolder = "ZoltIntentsNative";
const files = ["ZoltIntents.swift", "ZoltShortcuts.swift", "ZoltShortcutsBridge.m"];

function configureProject(project, root) {
  const folder = path.join(root, sourceFolder);
  fs.mkdirSync(folder, { recursive: true });
  for (const name of files)
    fs.copyFileSync(path.join(__dirname, "../native/intents", name), path.join(folder, name));
  const group = sourceGroup(project, sourceFolder);
  const host = project.getFirstTarget().uuid;
  for (const name of files) addSource(project, sourceFolder, name, host, group);
  return project;
}

function withShortcuts(config) {
  return withXcodeProject(config, (mod) => {
    configureProject(mod.modResults, mod.modRequest.platformProjectRoot);
    return mod;
  });
}
module.exports = withShortcuts;
module.exports.configureProject = configureProject;
