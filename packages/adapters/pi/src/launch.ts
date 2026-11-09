import type { OpenOptions } from "@zoltbot/adapters-sdk";
import type { AgentDefinition } from "@zoltbot/protocol";
import type { PiLaunch } from "./host.js";

const managed = new Set([
  "--mode",
  "--print",
  "-p",
  "--extension",
  "-e",
  "--no-extensions",
  "-ne",
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
  "--session",
  "--session-id",
  "--session-dir",
  "--no-session",
  "--fork",
  "--resume",
  "-r",
  "--continue",
  "-c",
  "--system-prompt",
  "--append-system-prompt",
  "--provider",
  "--model",
  "--thinking",
  "--tools",
  "--no-tools",
  "-nt",
  "--no-builtin-tools",
  "-nbt",
  "--no-mcp",
]);
export function piLaunch(
  definition: AgentDefinition,
  options: OpenOptions,
  files: { extension: string; config: string },
  nativeId: string,
): PiLaunch {
  if (definition.launch.args.some((arg) => managed.has(arg.split("=")[0] ?? arg)))
    throw new Error("conflicting_launch_flags");
  if (options.mode !== "new" && !options.nativeId && !options.fork?.sourceNativeId)
    throw new Error("native_id_required");
  if (options.fork && options.fork.boundary.kind !== "latest")
    throw Error("historical_fork_unavailable");
  const args = [
    ...definition.launch.args,
    "--mode",
    "rpc",
    "--no-extensions",
    "--extension",
    files.extension,
    "--extension",
    "builtin:mcp",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
  ];
  if (options.mode === "resume") args.push("--session", options.nativeId ?? "");
  else {
    if (options.mode === "fork")
      args.push("--fork", options.fork?.sourceNativeId ?? options.nativeId ?? "");
    args.push("--session-id", nativeId);
  }
  if (options.appendInstructions) args.push("--append-system-prompt", options.appendInstructions);
  if (options.model) {
    const [provider, ...model] = options.model.split(":");
    if (!provider || !model.length || !model.join(":")) throw new Error("model_provider_required");
    if (definition.flavor && provider !== definition.flavor) throw new Error("unsupported_model");
    args.push("--provider", provider, "--model", model.join(":"));
  }
  if (!options.model && definition.flavor) args.push("--provider", definition.flavor);
  if (options.effort) args.push("--thinking", options.effort);
  return {
    command: definition.launch.command,
    args,
    cwd: options.cwd,
    env: { ...definition.launch.env, ...options.env, ZOLTBOT_PI_CONFIG: files.config },
  };
}
