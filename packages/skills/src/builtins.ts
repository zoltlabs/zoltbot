import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { SkillsLibrary } from "./library.js";
import { readSkillFolder } from "./parser.js";
export const viewSkillSource = "builtin:building-zoltbot-views";
export function builtinSkill(source: string) {
  if (source !== viewSkillSource) return undefined;
  return readSkillFolder(
    realpathSync(fileURLToPath(new URL("../builtin/building-zoltbot-views/", import.meta.url))),
  );
}
/** Add trusted shipped content, without assignments, overwrites or resurrecting removals. */
export function installBuiltinSkills(library: SkillsLibrary) {
  if (!library.db.prepare("SELECT name FROM sqlite_master WHERE name='skill_library'").get())
    return;
  if (library.db.prepare("SELECT id FROM skill_library WHERE source=?").get(viewSkillSource))
    return;
  const bundle = builtinSkill(viewSkillSource);
  if (!bundle || library.list().some((entry) => entry.name === bundle.name)) return;
  library.add(bundle, viewSkillSource);
}
