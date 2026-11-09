/** Friendly names for native permission modes. Unknown modes show their own name. */
const labels: Record<string, string> = {
  default: "Supervised",
  acceptEdits: "Auto-accept edits",
  plan: "Plan mode",
  bypassPermissions: "Full access",
  auto: "Auto",
  dontAsk: "Full access",
};
const descriptions: Record<string, string> = {
  default: "Ask before commands and file changes.",
  acceptEdits: "Edit files without asking. Ask before other commands.",
  plan: "Look around and propose a plan. Change nothing.",
  bypassPermissions: "Run every tool without asking, including commands that change your system.",
  auto: "Decide which actions need your approval.",
  dontAsk: "Run allowed tools without asking. Deny the rest.",
};
export const modeLabel = (mode: string) => labels[mode] ?? (mode || "Default");
/** Sentence-case names for a profile's permission level. Unknown values read as sentence case. */
const permissionLabels: Record<string, string> = {
  read_only: "Read only",
  workspace_write: "Workspace write",
  workspace_write_net: "Workspace write and network",
  full_access: "Full access",
};
export const permissionLabel = (value: string) => {
  const words = value.replaceAll("_", " ");
  return permissionLabels[value] ?? words.charAt(0).toUpperCase() + words.slice(1);
};
export const modeDescription = (mode: string) => descriptions[mode] ?? "";
/**
 * I13 and I4: the adapter reports which modes never widen permission (capabilities.safeModes).
 * Any other mode widens and needs an explicit confirmation; without the list, every mode does.
 */
export const widensPermissions = (mode: string, safeModes: string[] | undefined) =>
  !safeModes?.includes(mode);

const strings = (value: unknown) =>
  Array.isArray(value)
    ? [...new Set(value.filter((mode): mode is string => typeof mode === "string" && !!mode))]
    : undefined;
export const sessionModes = (capabilities: Record<string, unknown>): string[] =>
  strings(capabilities.modes) ?? [];
export const sessionSafeModes = (capabilities: Record<string, unknown>): string[] | undefined =>
  strings(capabilities.safeModes);
/**
 * Shift+Tab steps through the safe modes in the order the provider reports them. Widening modes
 * stay in the picker, where they ask first.
 */
export function nextMode(
  modes: string[],
  current: string,
  safeModes: string[] | undefined,
): string | undefined {
  const cycle = modes.filter((mode) => !widensPermissions(mode, safeModes));
  if (!cycle.length || (cycle.length === 1 && cycle[0] === current)) return undefined;
  const at = cycle.indexOf(current);
  return cycle[(at + 1) % cycle.length];
}
