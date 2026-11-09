import path from "node:path";
import { scopeLineage } from "@zoltbot/core";
import type { Profile, Thread } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import type { LaunchManifest, SkillContribution } from "../../connections/src/launch-manifest.js";
import {
  materializeSkills,
  type SkillLayout,
  type SkillSnapshot,
  SkillsLibrary,
} from "../../skills/src/index.js";
import { reservedSkillNames } from "./skills-api.js";
export function skillsRuntime(store: Store, runtimeRoot: string) {
  const library = new SkillsLibrary(store.database);
  function available() {
    return !!store.database
      .prepare("SELECT name FROM sqlite_master WHERE name='skill_library'")
      .get();
  }
  const service = {
    validate(manifest: LaunchManifest, input: { thread: Thread; profile: Profile }) {
      if (JSON.stringify(service.select(input)) !== JSON.stringify(manifest.skills))
        throw new Error("skill_launch_selection_changed");
    },
    select(input: { thread: Thread; profile: Profile }): SkillContribution[] {
      if (!available()) return [];
      const scope =
        input.thread.node ??
        (input.thread.projectId
          ? { type: "project" as const, id: input.thread.projectId }
          : undefined);
      if (!scope) return [];
      const bound = scopeLineage(store.snapshot(), scope);
      const lineage = [bound.project.id, ...bound.directions.map((direction) => direction.id)];
      // Resolve only scopes bound to this thread, never caller-provided scope ids.
      const selected = library.resolve(input.profile.id, [...new Set(lineage)]);
      for (const skill of selected)
        if (reservedSkillNames.includes(skill.name)) throw new Error("skill_name_conflict");
      const task = input.thread.taskId ? store.record("task", input.thread.taskId) : undefined;
      const ids = (task?.routineInputs as { skills?: string[] } | undefined)?.skills;
      return selected
        .filter((skill) => !Array.isArray(ids) || ids.includes(skill.skillId))
        .map((skill) => ({
          id: skill.skillId,
          revision: skill.revision,
          hash: skill.hash,
          path: `skills/${skill.skillId}/${skill.revision}/${skill.hash}`,
          wrapperTokens: Math.ceil(
            (Buffer.byteLength(
              skill.name + library.revision(skill.skillId, skill.revision).bundle.description,
              "utf8",
            ) +
              512) /
              3,
          ),
        }));
    },
    materialize(manifest: LaunchManifest, layout?: SkillLayout) {
      const snapshot: SkillSnapshot = {
        manifestId: manifest.id,
        profileId: manifest.profileId,
        scopeId: manifest.projectId ?? manifest.threadId,
        skills: manifest.skills.map((skill) => ({
          skillId: skill.id,
          revision: skill.revision,
          hash: skill.hash,
          name: library.revision(skill.id, skill.revision).bundle.name,
        })),
      };
      const paths = materializeSkills(library, snapshot, runtimeRoot, layout);
      return snapshot.skills.map((skill, index) => {
        const wrapper = layout?.(skill),
          nativePath = paths[index] ?? "";
        let pluginPath = nativePath;
        for (
          let depth = 0;
          depth < (wrapper?.prefix.split("/").filter(Boolean).length ?? 0);
          depth++
        )
          pluginPath = path.dirname(pluginPath);
        return {
          namespace: wrapper?.namespace ?? `zoltbot-${skill.hash.slice(0, 12)}`,
          pluginPath,
          name: skill.name,
          path: nativePath,
        };
      });
    },
  };
  return service;
}
