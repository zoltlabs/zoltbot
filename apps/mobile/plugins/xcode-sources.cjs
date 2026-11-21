// Shared by the native plugins: put a copied source file in a group and in one target's
// Sources phase, once. A PBXFileReference may be shared by targets; a PBXBuildFile may not.

const unquote = (value) => String(value ?? "").replace(/^"|"$/g, "");

function sourceGroup(project, folder) {
  let group = project.findPBXGroupKey({ name: folder });
  if (!group) {
    group = project.addPbxGroup([], folder, '""').uuid;
    project.addToPbxGroup(group, project.getFirstProject().firstProject.mainGroup);
  }
  return group;
}

function addSource(project, folder, name, target, group) {
  const sourcePath = `${folder}/${name}`;
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

module.exports = { addSource, sourceGroup, unquote };
