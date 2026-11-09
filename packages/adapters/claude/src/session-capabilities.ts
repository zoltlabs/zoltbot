import type { Capabilities } from "@zoltbot/protocol";

export function claudeCapabilities(): Capabilities {
  return {
    resume: true,
    fork: true,
    nativeFork: {
      latest: false,
      boundaries: [],
      callerId: true,
      activation: "active",
      reason: "native_fork_canary_required",
    },
    steer: "native",
    concurrentTurns: false,
    interrupt: "native",
    modes: ["default", "plan"],
    models: { selectable: true },
    effort: [],
    approvals: "granular",
    questions: "native",
    planReview: "native",
    elicitation: "form",
    usage: { tokens: true, cost: true, context: true, cache: true },
    compaction: { auto: true, manual: true, events: true },
    hostTools: "mcp_http",
    images: true,
    nativeSessions: { list: false, adopt: true, visibleInOfficialApps: "unknown" },
    worktreeAware: true,
    rewind: true,
    backgroundTasks: true,
  };
}

/**
 * The models Claude's initialize result offers, and every effort level some model accepts;
 * Claude checks the pair when it is applied.
 */
export function claudeModelOptions(models: unknown[]) {
  const list: { id: string; name: string }[] = [];
  const effort = new Set<string>();
  for (const value of models) {
    const model = (value ?? {}) as {
      value?: unknown;
      displayName?: unknown;
      supportedEffortLevels?: unknown;
    };
    if (typeof model.value !== "string" || !model.value) continue;
    list.push({ id: model.value, name: String(model.displayName ?? model.value) });
    if (Array.isArray(model.supportedEffortLevels))
      for (const level of model.supportedEffortLevels)
        if (typeof level === "string" && level) effort.add(level);
  }
  return { list, effort: [...effort] };
}
