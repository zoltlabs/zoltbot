const fs = require("node:fs");
const path = require("node:path");
const { withXcodeProject } = require("expo/config-plugins");

// P2: the native lock cover. It draws in its own window above sheets, which a React Native
// Modal can't, and covers the app-switcher snapshot before iOS takes it.

const sourceFolder = "ZoltLockNative";
const files = ["LockCover.swift", "ZoltLock.swift", "ZoltLockBridge.m"];
const unquote = (value) => String(value ?? "").replace(/^"|"$/g, "");

function addSource(project, name, target, group) {
  const sourcePath = `${sourceFolder}/${name}`;
  let reference = Object.entries(project.pbxFileReferenceSection()).find(
    ([key, value]) => !key.endsWith("_comment") && unquote(value.path) === sourcePath,
  )?.[0];
  if (!reference) reference = project.addFile(sourcePath, group).fileRef;
  if (!project.getPBXGroupByKey(group).children.some((child) => child.value === reference))
    project.addToPbxGroup({ fileRef: reference, basename: name }, group);
  const phase = project.pbxSourcesBuildPhaseObj(target);
  const built = project.pbxBuildFileSection();
  if (phase.files.some((file) => built[file.value]?.fileRef === reference)) return;
  const file = {
    uuid: project.generateUuid(),
    fileRef: reference,
    basename: name,
    group: "Sources",
    target,
  };
  project.addToPbxBuildFileSection(file);
  project.addToPbxSourcesBuildPhase(file);
}

function configureProject(project, root) {
  const folder = path.join(root, sourceFolder);
  fs.mkdirSync(folder, { recursive: true });
  for (const name of files)
    fs.copyFileSync(path.join(__dirname, "../native/lock", name), path.join(folder, name));
  let group = project.findPBXGroupKey({ name: sourceFolder });
  if (!group) {
    group = project.addPbxGroup([], sourceFolder, '""').uuid;
    project.addToPbxGroup(group, project.getFirstProject().firstProject.mainGroup);
  }
  const host = project.getFirstTarget().uuid;
  for (const name of files) addSource(project, name, host, group);
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
