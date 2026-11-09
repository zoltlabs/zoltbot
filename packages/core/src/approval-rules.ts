import { type ApprovalRule, type ToolKind, tokenizeCommand } from "@zoltbot/protocol";

export interface ApprovalOperation {
  tool: string;
  kind?: ToolKind;
  agentId: string;
  projectId?: string;
  command?: string;
  /** Relative paths after the runtime has resolved real paths within its workspace. */
  paths?: readonly string[];
  pathsVerified?: boolean;
  host?: string;
  mcp?: { server: string; tool: string };
}
export { tokenizeCommand };

export function destructiveOperation(operation: ApprovalOperation): boolean {
  if (["delete", "move"].includes(operation.kind ?? "")) return true;
  if (operation.paths?.length && !operation.pathsVerified) return true;
  if (!operation.command) return false;
  const argv = tokenizeCommand(operation.command);
  if (!argv) return true;
  const executable = (argv[0] as string).split("/").at(-1)?.toLowerCase();
  const args = argv.slice(1);
  if (args.some((arg) => /(?:^|=)\//.test(arg) || arg.split(/[=/]/).includes(".."))) return true;
  if (
    [
      "sh",
      "bash",
      "zsh",
      "fish",
      "dash",
      "powershell",
      "pwsh",
      "cmd",
      "env",
      "sudo",
      "doas",
      "eval",
      "exec",
      "command",
      "xargs",
      "python",
      "python3",
      "node",
      "ruby",
      "perl",
      "osascript",
      "ssh",
    ].includes(executable ?? "")
  )
    return true;
  if (executable === "rm" && args.some((arg) => arg === "--recursive" || /^-[^-]*[rR]/.test(arg)))
    return true;
  if (executable === "git") {
    if (
      args.some(
        (arg) =>
          arg.startsWith("-c") ||
          arg.startsWith("--config-env") ||
          arg.startsWith("-C") ||
          arg.startsWith("--git-dir") ||
          arg.startsWith("--work-tree") ||
          arg.startsWith("--exec-path"),
      )
    )
      return true;
    if (args.includes("reset") && args.some((arg) => arg.startsWith("--hard"))) return true;
    if (
      args.includes("push") &&
      args.some((arg) => arg.startsWith("--force") || /^-[^-]*f/.test(arg))
    )
      return true;
    if (args.includes("clean")) return true;
  }
  if (
    executable === "find" &&
    args.some((arg) => ["-delete", "-exec", "-execdir", "-ok", "-okdir"].includes(arg))
  )
    return true;
  return /\bdrop\s+table\b/i.test(argv.join(" "));
}
function relativePath(value: string) {
  return (
    value.length > 0 &&
    value.length <= 4096 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    ![...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) &&
    value.split("/").every((part) => part !== ".." && part !== "." && part.length > 0)
  );
}
function segmentMatch(pattern: string, text: string) {
  let positions = new Set([0]);
  for (const char of pattern) {
    const next = new Set<number>();
    for (const index of positions) {
      if (char === "*") for (let end = index; end <= text.length; end++) next.add(end);
      else if (index < text.length && (char === "?" || char === text[index])) next.add(index + 1);
    }
    positions = next;
  }
  return positions.has(text.length);
}
function globMatch(pattern: string, value: string) {
  if (!relativePath(pattern) || !relativePath(value) || pattern.length > 512) return false;
  const patterns = pattern.split("/"),
    parts = value.split("/");
  if (patterns.length > 64 || parts.length > 64 || parts.some((part) => part.length > 256))
    return false;
  let positions = new Set([0]);
  for (const part of patterns) {
    const next = new Set<number>();
    for (const index of positions) {
      if (part === "**") for (let end = index; end <= parts.length; end++) next.add(end);
      else if (index < parts.length && segmentMatch(part, parts[index] as string))
        next.add(index + 1);
    }
    positions = next;
  }
  return positions.has(parts.length);
}
export function matchApprovalRule(
  rule: ApprovalRule,
  operation: ApprovalOperation,
  at: string,
): boolean {
  const now = Date.parse(at);
  if (!Number.isFinite(now) || rule.revokedAt || rule.createdBy.kind !== "human") return false;
  if (
    rule.expiresAt &&
    (!Number.isFinite(Date.parse(rule.expiresAt)) || Date.parse(rule.expiresAt) <= now)
  )
    return false;
  if (rule.scope === "project" && (!operation.projectId || rule.scopeId !== operation.projectId))
    return false;
  if (rule.scope === "agent" && rule.scopeId !== operation.agentId) return false;
  if (rule.scope === "global" && rule.scopeId !== undefined) return false;
  const matcher = rule.matcher;
  if (
    (matcher.command?.prefix.length ?? 0) > 256 ||
    (matcher.paths?.length ?? 0) > 100 ||
    (operation.paths?.length ?? 0) > 100
  )
    return false;
  if (matcher.tool !== operation.tool && matcher.tool !== operation.kind) return false;
  if (matcher.kind && matcher.kind !== operation.kind) return false;
  if (matcher.command) {
    const argv = operation.command ? tokenizeCommand(operation.command) : undefined;
    if (
      !argv ||
      !matcher.command.prefix.length ||
      matcher.command.prefix.some((arg, index) => arg !== argv[index])
    )
      return false;
  }
  if (
    matcher.paths &&
    (!operation.paths?.length ||
      !operation.pathsVerified ||
      !operation.paths.every((value) =>
        matcher.paths?.some((pattern) => globMatch(pattern, value)),
      ))
  )
    return false;
  if (
    matcher.host &&
    (matcher.host.toLowerCase() !== operation.host?.toLowerCase() ||
      !/^[a-z0-9.-]+$/i.test(matcher.host))
  )
    return false;
  if (
    matcher.mcp &&
    (matcher.mcp.server !== operation.mcp?.server || matcher.mcp.tool !== operation.mcp?.tool)
  )
    return false;
  if (rule.decision === "allow") {
    if (!operation.kind) return false;
    if ((operation.kind === "execute" || operation.command !== undefined) && !matcher.command)
      return false;
    if (operation.kind === "edit" && (!matcher.paths || !operation.pathsVerified)) return false;
    if (destructiveOperation(operation)) return false;
  }
  return true;
}
export function decideApproval(
  rules: readonly ApprovalRule[],
  operation: ApprovalOperation,
  at: string,
): ApprovalRule | undefined {
  const rank = { project: 3, agent: 2, global: 1 };
  return rules
    .filter((rule) => matchApprovalRule(rule, operation, at))
    .sort(
      (a, b) =>
        Number(b.decision === "deny") - Number(a.decision === "deny") ||
        rank[b.scope] - rank[a.scope] ||
        a.id.localeCompare(b.id),
    )[0];
}
