import { existsSync, lstatSync, readdirSync } from "node:fs";
import path from "node:path";
import { readSkillFolder } from "./parser.js";
export interface DetectedSkill {
  source: string;
  provider: string;
  name?: string;
  description?: string;
  hash?: string;
  error?: string;
}
export function detectSkills(
  locations: readonly { directory: string; provider: string }[],
): DetectedSkill[] {
  const detected: DetectedSkill[] = [];
  for (const { directory, provider } of locations) {
    if (!existsSync(directory)) continue;
    if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) {
      detected.push({
        source: directory,
        provider,
        error: "Symlink or non-directory source; choose another folder",
      });
      continue;
    }
    for (const name of readdirSync(directory).sort().slice(0, 200)) {
      const source = path.join(directory, name);
      try {
        const skill = readSkillFolder(source);
        detected.push({
          source,
          provider,
          name: skill.name,
          description: skill.description,
          hash: skill.hash,
        });
      } catch {
        detected.push({
          source,
          provider,
          error: "Cannot safely read this folder; review it on your Mac",
        });
      }
    }
  }
  return detected;
}
