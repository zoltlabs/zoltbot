import type { EffortLevel, Options, PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import type { OpenOptions } from "@zoltbot/adapters-sdk";
import type { AgentDefinition } from "@zoltbot/protocol";

const managed = new Set([
  "-p",
  "--print",
  "--input-format",
  "--output-format",
  "--verbose",
  "--include-partial-messages",
  "--replay-user-messages",
  "--session-id",
  "--resume",
  "--continue",
  "-c",
  "--fork-session",
  "-n",
  "--name",
  "--permission-mode",
  "--permission-prompts",
  "--permission-prompt-tool",
  "--dangerously-skip-permissions",
  "--allow-dangerously-skip-permissions",
  "--mcp-config",
  "--strict-mcp-config",
  "--append-system-prompt",
  "--system-prompt",
  "--allowedTools",
  "--disallowedTools",
  "--tools",
  "--no-session-persistence",
  "--bare",
  "-w",
  "--worktree",
  "--model",
  "--effort",
  "--plugin-dir",
  "--plugin-url",
  "--settings",
  "--thinking",
  "--thinking-display",
]);
// Read only is enforced by the disallowed tools below and host approvals, not plan mode:
// Claude treats plan mode as "change nothing" and refuses host tools such as delegation.
export function claudeMode(options: OpenOptions) {
  return options.permissionProfile === "full_access" ? "bypassPermissions" : "default";
}
/**
 * Native permission modes a profile may select (I10). acceptEdits only auto approves edits inside
 * the workspace, which workspace_write already allows. bypassPermissions and auto are full access.
 */
export function claudeModes(options: OpenOptions) {
  if (options.permissionProfile === "read_only") return ["default", "plan"];
  if (options.permissionProfile === "full_access")
    return ["default", "acceptEdits", "plan", "bypassPermissions", "auto"];
  return ["default", "acceptEdits", "plan"];
}
/** Modes that never widen what the agent may do without asking; the rest need confirmation. */
export function claudeSafeModes(options: OpenOptions) {
  return options.permissionProfile === "read_only"
    ? ["default", "plan"]
    : ["default", "plan", "acceptEdits"];
}
/**
 * Agent SDK options for one native process. The daemon supplies the process through
 * spawnClaudeCodeProcess, so pathToClaudeCodeExecutable only names it for the SDK. MCP
 * credentials stay in the private config file rather than argv, and the replayed user frame
 * carries the uuid that file checkpoints are keyed by.
 */
export function claudeOptions(
  definition: AgentDefinition,
  options: OpenOptions,
  mcpFile: string,
  nativeId: string,
  mode = claudeMode(options),
): Options {
  if (definition.launch.args.some((arg) => managed.has(arg.split("=")[0] ?? arg)))
    throw new Error("conflicting_launch_flags");
  if (options.mode !== "new" && !options.nativeId && !options.fork?.sourceNativeId)
    throw new Error("native_id_required");
  if (options.fork && options.fork.boundary.kind !== "latest")
    throw Error("historical_fork_unavailable");
  // A bare mcp__<server> rule covers every tool that server provides.
  const disallowed = [
    ...(options.permissionProfile === "read_only" ? ["Edit", "Write", "NotebookEdit", "Bash"] : []),
    ...(options.ownTools ? (options.ownToolsOff ?? []).map((name) => `mcp__${name}`) : []),
  ];
  return {
    pathToClaudeCodeExecutable: definition.launch.command,
    cwd: options.cwd,
    env: { ...definition.launch.env, ...options.env },
    permissionMode: mode as PermissionMode,
    // Claude 2.1.42 keeps bypassPermissions selectable only when launched in it or with this flag.
    // A full access session relaunched in another mode must still be able to switch back (I10).
    allowDangerouslySkipPermissions: options.permissionProfile === "full_access",
    allowedTools: ["mcp__zoltbot__*"],
    ...(disallowed.length ? { disallowedTools: disallowed } : {}),
    strictMcpConfig: !options.ownTools,
    includePartialMessages: true,
    // The SDK enables native file checkpoints, which rewind_files restores.
    enableFileCheckpointing: true,
    // Claude overwrites a CLI --append-system-prompt with the initialize append, so it goes here.
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      ...(options.appendInstructions ? { append: options.appendInstructions } : {}),
    },
    plugins: (options.managedSkills ?? []).map((skill) => ({
      type: "local" as const,
      path: skill.pluginPath,
    })),
    ...(options.model ? { model: options.model } : {}),
    ...(options.effort ? { effort: options.effort as EffortLevel } : {}),
    ...(options.mode === "new"
      ? { sessionId: nativeId, ...(options.name ? { title: options.name } : {}) }
      : {
          resume:
            (options.mode === "fork" ? options.fork?.sourceNativeId : undefined) ??
            options.nativeId ??
            "",
          ...(options.mode === "fork" ? { forkSession: true, sessionId: nativeId } : {}),
        }),
    // As T3 Code does: summaries keep thinking text visible on models that omit it by default,
    // without forcing thinking on when the person turned it off.
    settings: { showThinkingSummaries: true },
    extraArgs: {
      "mcp-config": mcpFile,
      "replay-user-messages": null,
      "thinking-display": "summarized",
      // A title on a new session skips Claude's naming request; a resumed one keeps its title
      // unless a rename relaunches it with --name.
      ...(options.name && options.mode !== "new" ? { name: options.name } : {}),
    },
  };
}
