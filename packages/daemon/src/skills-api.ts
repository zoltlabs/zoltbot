import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { scopeLineage } from "@zoltbot/core";
import { compareSessions, type DomainEvent } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import {
  builtinSkill,
  detectSkills,
  installBuiltinSkills,
  parseSkill,
  readSkillFolder,
  type SkillBundle,
  SkillsLibrary,
} from "../../skills/src/index.js";
import { fetchGithubSkill, type GithubFetchOptions, isGithubSource } from "./skill-github.js";

// Reserved built-ins are conservative; provider-reported names must be added by the launch resolver.
export const reservedSkillNames = [
  "help",
  "clear",
  "compact",
  "config",
  "cost",
  "doctor",
  "exit",
  "init",
  "login",
  "logout",
  "model",
  "permissions",
  "plan",
  "resume",
  "review",
  "status",
  "skills",
  "plugin",
  "plugins",
  "agents",
  "mcp",
  "memory",
  "fork",
  "rename",
  "rewind",
  "context",
  "usage",
  "feedback",
  "bug",
  "quit",
  "diff",
  "mention",
  "new",
  "apps",
];
export function skillsApi(options: {
  store: Store;
  checkPublic(value: unknown): Promise<unknown>;
  publish?(events: DomainEvent[]): void;
  onChanged?(): void;
  github?: GithubFetchOptions;
}) {
  const library = new SkillsLibrary(options.store.database);
  installBuiltinSkills(library);
  const readSource = (source: string) => builtinSkill(source) ?? readSkillFolder(source);
  const previews = new Map<
    string,
    { bundle: SkillBundle; folder: string; expires: number; commit?: string }
  >();
  const string = (p: Record<string, unknown>, key: string) => {
    if (typeof p[key] !== "string") throw new Error("invalid_skill_params");
    return p[key] as string;
  };
  const prune = () => {
    for (const [id, value] of previews) if (value.expires < Date.now()) previews.delete(id);
    if (previews.size >= 20) throw new Error("skill_preview_limit");
  };
  const remember = (bundle: SkillBundle, folder: string, commit?: string) => {
    const previewId = randomUUID();
    prune();
    previews.set(previewId, {
      bundle,
      folder,
      expires: Date.now() + 10 * 60 * 1000,
      ...(commit ? { commit } : {}),
    });
    return { previewId, bundle, source: folder, ...(commit ? { commit } : {}) };
  };
  /** M5: a GitHub link is fetched once and pinned to the commit shown in the preview. */
  // One fetch at a time, and only when there is room for its preview.
  let fetching = false;
  const fetchLink = async (url: string) => {
    prune();
    if (fetching) throw new Error("skill_link_busy: another link is still being read.");
    fetching = true;
    try {
      const fetched = await fetchGithubSkill(url, options.github);
      return remember(fetched.bundle, fetched.source, fetched.commit);
    } finally {
      fetching = false;
    }
  };
  const preview = async (folder: string) =>
    isGithubSource(folder) ? fetchLink(folder) : remember(readSource(folder), folder);
  function reviewed(p: Record<string, unknown>) {
    const value = previews.get(string(p, "previewId"));
    if (!value || value.expires < Date.now() || value.bundle.hash !== p.hash)
      throw new Error("skill_preview_expired: choose folder again");
    // A fetched link is pinned to its commit; the preview is exactly what installs.
    if (!value.commit && readSource(value.folder).hash !== value.bundle.hash)
      throw new Error("skill_source_changed: review again");
    return value;
  }
  return async (method: string, p: Record<string, unknown>, commandId?: string) => {
    if (!method.startsWith("skill.")) return undefined;
    const mutate = [
      "skill.import.apply",
      "skill.import.link.apply",
      "skill.save",
      "skill.remove",
      "skill.access",
      "skill.update.apply",
    ].includes(method);
    if (mutate && !commandId) throw new Error("command_id_required");
    if (mutate) {
      const receipt = options.store.receipt(commandId ?? "");
      if (receipt) return receipt.result;
    }
    const guards: ((state: ReturnType<Store["snapshot"]>) => void)[] = [];
    async function check(value: unknown) {
      const guard = await options.checkPublic(value);
      if (typeof guard === "function")
        guards.push(guard as (state: ReturnType<Store["snapshot"]>) => void);
    }
    await check({ params: p, ...(commandId ? { commandId } : {}) });
    let operation: () => unknown;
    switch (method) {
      case "skill.list":
        return { skills: library.list() };
      case "skill.get": {
        const id = string(p, "id"),
          entry = library.get(id);
        return {
          entry,
          revision: library.revision(id, Number(p.revision ?? entry.current_revision)),
          history: library.history(id),
        };
      }
      case "skill.detect":
        return {
          skills: detectSkills([
            { directory: path.join(os.homedir(), ".claude/skills"), provider: "Claude" },
            { directory: path.join(os.homedir(), ".agents/skills"), provider: "Codex" },
          ]),
        };
      case "skill.import.preview": {
        const source = p.source as { kind?: unknown; url?: unknown } | undefined;
        const result = await preview(
          source?.kind === "github" && typeof source.url === "string"
            ? source.url
            : string(p, "folder"),
        );
        await check(result);
        return result;
      }
      case "skill.import.link": {
        // Only ever a fetch: a phone must not read folders on the Mac through this method.
        const result = await fetchLink(string(p, "url"));
        await check(result);
        return result;
      }
      case "skill.import.apply":
      case "skill.import.link.apply": {
        const value = reviewed(p);
        // The phone's install only takes previews fetched from a link.
        if (method === "skill.import.link.apply" && !value.commit)
          throw new Error("skill_preview_expired: choose folder again");
        await check(value.bundle);
        const previewId = string(p, "previewId");
        operation = () => {
          const added = library.add(value.bundle, value.folder);
          previews.delete(previewId);
          return added;
        };
        break;
      }
      case "skill.save": {
        const bundle = parseSkill(p.files as { path: string; content: string }[]);
        await check(bundle);
        operation = () =>
          p.id
            ? library.save(string(p, "id"), Number(p.expectedRevision), bundle)
            : library.add(bundle);
        break;
      }
      case "skill.remove":
        operation = () => {
          library.remove(string(p, "id"), p.confirmed === true);
          return { ok: true };
        };
        break;
      case "skill.access": {
        const state = options.store.snapshot(),
          profileId = string(p, "profileId"),
          scopeId = string(p, "scopeId");
        if (
          !(state.agent ?? []).some((row) => row.id === profileId) ||
          ![...(state.project ?? []), ...(state.subproject ?? [])].some((row) => row.id === scopeId)
        )
          throw new Error("skill_scope_not_found");
        operation = () => {
          library.assign({
            profileId,
            scopeId,
            skillId: string(p, "skillId"),
            revision: Number(p.revision),
            enabled: p.enabled === true,
            confirmed: p.confirmed === true,
            reservedNames: reservedSkillNames,
          });
          return { ok: true };
        };
        break;
      }
      case "skill.assignments":
        return { assignments: library.assignments(string(p, "profileId"), string(p, "scopeId")) };
      case "skill.update.preview": {
        const entry = library.get(string(p, "id"));
        if (!entry.source) throw new Error("skill_has_no_source");
        const result = await preview(entry.source);
        await check(result);
        return result;
      }
      case "skill.update.apply": {
        const value = reviewed(p),
          id = string(p, "id");
        if (library.get(id).source !== value.folder) throw new Error("skill_source_mismatch");
        const choice = p.choice as "keep" | "replace" | "copy";
        const candidate =
          choice === "copy" && p.files
            ? parseSkill(p.files as { path: string; content: string }[])
            : value.bundle;
        await check(candidate);
        operation = () => library.updateSource(id, Number(p.expectedRevision), candidate, choice);
        break;
      }
      case "skill.context": {
        const state = options.store.snapshot(),
          task =
            p.preview === true
              ? {
                  id: p.taskId,
                  ownerAgentId: p.profileId,
                  node: p.scope,
                  threadId: undefined,
                  projectId: undefined,
                }
              : (state.task ?? []).find((row) => row.id === p.taskId);
        if (!task) throw new Error("task_not_found");
        if (
          p.preview === true &&
          (typeof p.profileId !== "string" ||
            !p.scope ||
            !(state.agent ?? []).some((profile) => profile.id === p.profileId && !profile.archived))
        )
          throw new Error("skill_preview_scope_required");
        const session = (state.session ?? [])
          .filter((row) => row.threadId === task.threadId)
          .sort(compareSessions)[0];
        const configuration = (state.settings ?? []).find(
          (row) => row.key === `runtime.configuration.${session?.id}`,
        )?.value as
          | {
              launchManifest?: {
                id: string;
                profileId: string;
                projectId?: string;
                skills: { id: string; revision: number; hash: string }[];
              };
            }
          | undefined;
        const manifest = configuration?.launchManifest;
        const scope =
          task.node ?? (task.projectId ? { type: "project", id: task.projectId } : undefined);
        const lineage = scope ? scopeLineage(state, scope) : undefined;
        const selected =
          !manifest && lineage && typeof task.ownerAgentId === "string"
            ? library.resolve(task.ownerAgentId, [
                lineage.project.id,
                ...lineage.directions.map((direction) => direction.id),
              ])
            : [];
        const snapshot = manifest
          ? {
              manifestId: manifest.id,
              profileId: manifest.profileId,
              scopeId: manifest.projectId ?? String(task.id),
              skills: manifest.skills.map((skill) => ({
                skillId: skill.id,
                revision: skill.revision,
                hash: skill.hash,
                name: library.revision(skill.id, skill.revision).bundle.name,
                ...((
                  session?.capabilities as { slashCommands?: { name: string }[] } | undefined
                )?.slashCommands?.some(
                  (command) =>
                    command.name ===
                    `zoltbot-${skill.hash.slice(0, 12)}:${library.revision(skill.id, skill.revision).bundle.name}`,
                )
                  ? {
                      reportedLoaded: true,
                      installedPath: `skills/${skill.id}/${skill.revision}/${skill.hash}`,
                    }
                  : {}),
              })),
            }
          : selected.length
            ? {
                manifestId: "preview",
                profileId: String(task.ownerAgentId),
                scopeId: lineage?.project.id ?? String(task.id),
                skills: selected,
              }
            : null;

        return {
          snapshot: snapshot ?? null,
          current: library.list(),
          capability: {
            supported: snapshot?.skills.some((skill) => "reportedLoaded" in skill) ?? false,
            reason:
              "Native skill availability is checked at start; unknown observations remain Not reported",
          },
        };
      }
      default:
        return undefined;
    }
    const before = options.store.lastSeq();
    const receipt = options.store.dispatch(commandId as string, (state) => {
      for (const guard of guards) guard(state);
      const result = operation(),
        eventId = randomUUID();
      return {
        result,
        events: [
          {
            eventId,
            aggregateType: "settings",
            aggregateId: "skills.libraryRevision",
            type: "settings.updated",
            occurredAt: new Date().toISOString(),
            payload: { key: "skills.libraryRevision", value: eventId },
          },
        ],
      };
    });
    options.publish?.(options.store.eventsSince(before));
    options.onChanged?.();
    return receipt.result;
  };
}
