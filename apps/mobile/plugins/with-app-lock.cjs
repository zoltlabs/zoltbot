const fs = require("node:fs");
const path = require("node:path");
const { withXcodeProject } = require("expo/config-plugins");
const { addSource, sourceGroup } = require("./xcode-sources.cjs");

// P2: the native lock cover. It draws in its own window above sheets, which a React Native
// Modal can't, and covers the app-switcher snapshot before iOS takes it.

const sourceFolder = "ZoltLockNative";
const files = ["LockCover.swift", "ZoltLock.swift", "ZoltLockBridge.m"];

function configureProject(project, root) {
  const folder = path.join(root, sourceFolder);
  fs.mkdirSync(folder, { recursive: true });
  for (const name of files)
    fs.copyFileSync(path.join(__dirname, "../native/lock", name), path.join(folder, name));
  const group = sourceGroup(project, sourceFolder);
  const host = project.getFirstTarget().uuid;
  for (const name of files) addSource(project, sourceFolder, name, host, group);
  return project;
}

function withAppLock(config) {
  return withXcodeProject(config, (mod) => {
    configureProject(mod.modResults, mod.modRequest.platformProjectRoot);
    return mod;
  });
}
module.exports = withAppLock;
module.exports.configureProject = configureProject;
