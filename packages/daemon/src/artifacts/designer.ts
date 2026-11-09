import { randomUUID } from "node:crypto";
import { applyEvents, handle } from "@zoltbot/core";
import { ProfileSchema, parse } from "@zoltbot/protocol";
import { repositoryLock } from "../../../gitkit/src/git.js";
import type { RuntimeContext } from "../api.js";
import { contentHash } from "./model.js";
export async function artifactDesigner(
  context: RuntimeContext,
  projectId: string | undefined,
  commandId: string,
) {
  const key = `artifact.designer.${contentHash(projectId ?? "global")}`;
  return repositoryLock(key, async () => {
    const digest = contentHash(JSON.stringify({ projectId }));
    const receipt = context.store.receipt<{ digest: string; id: string }>(commandId);
    if (receipt) {
      if (receipt.result.digest !== digest) throw Error("command_receipt_conflict");
      return { id: receipt.result.id };
    }
    const state = context.store.snapshot(["project", "agent", "agentDefinition", "settings"]);
    if (projectId && !state.project?.some((p) => p.id === projectId && !p.archived))
      throw Error("project_unavailable");
    const claude = new Set(
      state.agentDefinition?.filter((d) => d.adapter === "claude").map((d) => d.id),
    );
    const priorId = (
      state.settings?.find((s) => s.key === key)?.value as { id?: string } | undefined
    )?.id;
    const registered = new Set(
      (state.settings ?? [])
        .filter((s) => String(s.key).startsWith("artifact.designer."))
        .map((s) => (s.value as { id?: string }).id),
    );
    const prior =
      state.agent?.find((a) => a.id === priorId && !a.archived && claude.has(a.definitionId)) ??
      state.agent?.find(
        (a) => registered.has(String(a.id)) && !a.archived && claude.has(a.definitionId),
      );
    const base = state.agent?.find((a) => !a.archived && !a.hidden && claude.has(a.definitionId));
    if (!prior && !base) throw Error("artifact_designer_requires_claude_profile");
    const at = new Date().toISOString();
    const profile =
      prior ??
      parse(ProfileSchema, {
        ...base,
        id: randomUUID(),
        name: "Claude Designer",
        template: "artifact_designer",
        avatar: "D",
        instructions: `${String(base?.instructions ?? "")}\nDesign polished, responsive offline artifacts with clear hierarchy, generous spacing and accessible controls. Respect the project's design context and reuse artifact keys.`,
        hidden: false,
        archived: false,
        createdAt: at,
        updatedAt: at,
      });
    const guard = await context.privacy.prepareData(profile);
    const before = context.store.lastSeq();
    const result = context.store.dispatch(commandId, (snapshot) => {
      guard(snapshot);
      const actor = { kind: "human" as const, id: "local-owner" };
      const created = prior
        ? []
        : handle(
            snapshot,
            { type: "create", kind: "agent", value: profile },
            { commandId, actor, at },
          ).events;
      const next = applyEvents(snapshot, created);
      const indexed = handle(
        next,
        next.settings?.some((s) => s.key === key)
          ? { type: "update", kind: "settings", id: key, changes: { value: { id: profile.id } } }
          : { type: "create", kind: "settings", value: { key, value: { id: profile.id } } },
        { commandId: `${commandId}:index`, actor, at },
      );
      return { events: [...created, ...indexed.events], result: { digest, id: profile.id } };
    });
    context.publish(context.store.eventsSince(before));
    return { id: result.result.id };
  });
}
