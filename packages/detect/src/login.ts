import { type CommandRunner, runCommand } from "./process.js";

// Plan names come from a fixed list so account details such as email or org never leave the probe.
const claudePlans: Record<string, string> = {
  pro: "Pro plan",
  max: "Max plan",
  team: "Team plan",
  enterprise: "Enterprise plan",
};
export type LoginState = "signed_in" | "signed_out" | "unknown" | "api_key_configured";
export async function checkLogin(options: {
  adapter: string;
  command: string;
  args?: string[];
  cwd: string;
  apiKeyConfigured?: boolean;
  runner?: CommandRunner;
  inherited?: NodeJS.ProcessEnv;
}): Promise<{ state: LoginState; plan?: string; error?: string }> {
  if (options.apiKeyConfigured) return { state: "api_key_configured" };
  if (!options.args || !["claude", "codex", "cursor"].includes(options.adapter))
    return { state: "unknown" };
  const result = await (options.runner ?? runCommand)(options.command, options.args, {
    cwd: options.cwd,
    ...(options.inherited ? { inherited: options.inherited } : {}),
    timeoutMs: 5000,
  });
  if (result.failure) return { state: "unknown", error: result.failure };
  if (options.adapter === "claude") {
    try {
      const value: unknown = JSON.parse(result.stdout);
      if (value && typeof value === "object" && "loggedIn" in value) {
        if (value.loggedIn === true) {
          const tier = "subscriptionType" in value ? String(value.subscriptionType) : "";
          const plan = Object.hasOwn(claudePlans, tier) ? claudePlans[tier] : "";
          return plan ? { state: "signed_in", plan } : { state: "signed_in" };
        }
        if (value.loggedIn === false) return { state: "signed_out" };
      }
    } catch {
      /* Unrecognized native output remains unknown. */
    }
  }
  if (options.adapter === "codex") {
    const output = `${result.stdout}\n${result.stderr}`;
    if (/^Logged in (?:using|with) /m.test(output) && result.code === 0)
      return /^Logged in using ChatGPT\s*$/m.test(output)
        ? { state: "signed_in", plan: "ChatGPT" }
        : { state: "signed_in" };
    if (/^Not logged in\s*$/m.test(output)) return { state: "signed_out" };
  }
  if (options.adapter === "cursor") {
    const output = `${result.stdout}\n${result.stderr}`;
    if (/^\s*(?:✓\s*)?Logged in as /m.test(output) && result.code === 0)
      return { state: "signed_in" };
    if (/^\s*Not logged in\s*$/m.test(output)) return { state: "signed_out" };
  }
  return { state: "unknown" };
}
