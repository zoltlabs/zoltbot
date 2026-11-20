import type { Row } from "./daemon-client";

/** Agents a new chat starts with when none is chosen, in the order onboarding prefers them. */
const preferredAgents = ["claude", "codex", "antigravity"];

/**
 * Picks the agent profile for a new chat: the one asked for, then the project's default, then
 * Claude Code, Codex or Antigravity, then any other profile.
 */
export function chooseAgent(
  profiles: readonly Row[],
  wanted: { profileId?: string; defaultAgentId?: unknown } = {},
): Row | undefined {
  const choices = profiles.filter((row) => row.kind === "profile");
  return (
    profiles.find((row) => row.id === wanted.profileId) ??
    profiles.find((row) => row.id === wanted.defaultAgentId) ??
    preferredAgents.map((id) => choices.find((row) => row.definitionId === id)).find(Boolean) ??
    choices[0] ??
    profiles[0]
  );
}
