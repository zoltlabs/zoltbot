import path from "node:path";
import { tokenizeCommand } from "@zoltbot/protocol";
import { editTools } from "./tools.js";

/** What the session lets an answer grant. Modes follow the permission profile (I10). */
export interface ClaudePolicy {
  modes: readonly string[];
  /** The mode a plan approval without auto accepted edits returns to. */
  baseMode: string;
  cwd?: string;
}
export const narrowPolicy: ClaudePolicy = { modes: ["default", "plan"], baseMode: "default" };

type Value = Record<string, unknown>;
export type ClaudePermissionUpdate =
  | {
      type: "addRules";
      rules: { toolName: string; ruleContent?: string }[];
      behavior: "allow";
      destination: "session";
    }
  | { type: "setMode"; mode: string; destination: "session" };
export interface RuleMatcher {
  tool: string;
  kind?: "execute" | "fetch" | "edit" | "other";
  command?: { prefix: string[] };
  paths?: string[];
  host?: string;
}
const object = (value: unknown): Value | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Value) : undefined;
const name = (value: unknown) =>
  typeof value === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(value) ? value : undefined;

/**
 * Keep only native permission suggestions that are safe to apply for this session. The
 * destination is always forced to "session": Zoltbot's rule store is the durable source (I11),
 * so nothing is written to Claude settings files. Directory grants widen the filesystem boundary
 * and are never forwarded; deny, ask, replace, and remove updates are dropped.
 */
export function sessionGrants(raw: unknown, policy: ClaudePolicy): ClaudePermissionUpdate[] {
  if (!Array.isArray(raw)) return [];
  const grants: ClaudePermissionUpdate[] = [];
  for (const value of raw.slice(0, 20)) {
    const update = object(value);
    if (!update) continue;
    if (update.type === "addRules" && update.behavior === "allow" && Array.isArray(update.rules)) {
      const rules = update.rules.slice(0, 20).flatMap((item) => {
        const rule = object(item),
          toolName = name(rule?.toolName);
        if (!rule || !toolName) return [];
        if (rule.ruleContent === undefined) return [{ toolName }];
        return typeof rule.ruleContent === "string" &&
          rule.ruleContent.length > 0 &&
          rule.ruleContent.length <= 1000
          ? [{ toolName, ruleContent: rule.ruleContent }]
          : [];
      });
      if (rules.length)
        grants.push({ type: "addRules", rules, behavior: "allow", destination: "session" });
    } else if (
      // Only auto accepted edits: it stays inside workspace writes the profile already allows.
      update.type === "setMode" &&
      update.mode === "acceptEdits" &&
      policy.modes.includes(update.mode)
    )
      grants.push({ type: "setMode", mode: update.mode, destination: "session" });
  }
  return grants;
}
const maxLabel = 200;
/**
 * The session grant offered as allow_session, with a label naming everything it grants. When
 * the label would not fit, the choice is not offered rather than hiding part of the grant.
 */
export function sessionChoice(raw: unknown, policy: ClaudePolicy) {
  const grants = sessionGrants(raw, policy);
  if (!grants.length) return undefined;
  const label = grantLabel(grants);
  return label.length <= maxLabel ? { grants, label } : undefined;
}
function grantLabel(grants: ClaudePermissionUpdate[]) {
  return grants
    .flatMap((grant) =>
      grant.type === "addRules"
        ? grant.rules.map((rule) =>
            rule.ruleContent === undefined
              ? rule.toolName
              : `${rule.toolName}(${rule.ruleContent})`,
          )
        : [`mode ${grant.mode}`],
    )
    .join(", ");
}

const broad = /[*?[\]{}]/;
function commandRule(command: unknown, grants: ClaudePermissionUpdate[]): RuleMatcher | undefined {
  if (typeof command !== "string") return undefined;
  const argv = tokenizeCommand(command);
  if (!argv) return undefined;
  for (const grant of grants) {
    if (grant.type !== "addRules") continue;
    for (const rule of grant.rules) {
      // Only native prefix rules ("npm test:*") become prefix matchers. An exact rule names one
      // command, but the daemon matches by argv prefix, so it would also allow longer commands.
      if (rule.toolName !== "Bash" || !rule.ruleContent?.endsWith(":*")) continue;
      const prefix = tokenizeCommand(rule.ruleContent.slice(0, -2));
      // At least two words, no wildcard, and it must cover the command being asked about.
      if (
        prefix &&
        prefix.length >= 2 &&
        !prefix.some((arg) => broad.test(arg)) &&
        prefix.every((arg, index) => argv[index] === arg)
      )
        return { tool: "Bash", kind: "execute", command: { prefix } };
    }
  }
  return undefined;
}
export function fetchTarget(url: unknown) {
  if (typeof url !== "string") return undefined;
  try {
    const parsed = new URL(url);
    const protocol = parsed.protocol.slice(0, -1);
    if (!["http", "https"].includes(protocol)) return undefined;
    const host = parsed.hostname.toLowerCase();
    return /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(host) ? { host, protocol } : undefined;
  } catch {
    return undefined;
  }
}
// One exact host, as Claude's own "domain:" suggestion would grant.
function hostRule(url: unknown): RuleMatcher | undefined {
  const target = fetchTarget(url);
  return target ? { tool: "WebFetch", kind: "fetch", host: target.host } : undefined;
}
function pathRule(tool: string, file: unknown, cwd?: string): RuleMatcher | undefined {
  if (typeof file !== "string" || !cwd || !path.isAbsolute(file) || broad.test(file))
    return undefined;
  const relative = path.relative(cwd, file).split(path.sep).join("/");
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return { tool, kind: "edit", paths: [relative] };
}
/**
 * A narrow rule Zoltbot can offer as "Always allow". It mirrors how the daemon matches
 * approvals: operation.tool is the native tool name, and command, host, and paths come from the
 * interaction context. Commands need a native prefix suggestion of at least two words.
 */
export function ruleSuggestion(
  tool: string,
  input: Value,
  grants: ClaudePermissionUpdate[],
  cwd?: string,
): RuleMatcher | undefined {
  if (tool === "Bash") return commandRule(input.command, grants);
  if (tool === "WebFetch") return hostRule(input.url);
  if (editTools.includes(tool))
    return pathRule(tool, tool === "NotebookEdit" ? input.notebook_path : input.file_path, cwd);
  // The tool name already names the server and the tool; the daemon matches it exactly.
  if (/^mcp__[^_]+__[^_].*$/.test(tool)) return { tool, kind: "other" };
  return undefined;
}
