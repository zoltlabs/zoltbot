import { tokenizeCommand } from "./command-prefix.js";

// These programs can replace the meaning of a prefix or affect the host's settings/credentials.
const fresh = new Set([
  "sudo",
  "su",
  "doas",
  "security",
  "osascript",
  "defaults",
  "systemsetup",
  "networksetup",
  "scutil",
  "launchctl",
  "pmset",
  "dscl",
  "diskutil",
  "nvram",
  "csrutil",
]);
const wrappers = new Set([
  "sh",
  "zsh",
  "bash",
  "fish",
  "csh",
  "tcsh",
  "ksh",
  "dash",
  "env",
  "command",
  "builtin",
  "eval",
  "exec",
  "nohup",
  "nice",
  "xargs",
  "find",
  "parallel",
  "ssh",
  "python",
  "python3",
  "node",
  "ruby",
  "perl",
  "php",
  "lua",
  "npx",
  "bunx",
  "busybox",
  "toybox",
]);
const basename = (token: string) => token.split("/").at(-1) ?? "";
export function macPrefixCandidate(command: string): string | undefined {
  const argv = tokenizeCommand(command);
  if (!argv) return;
  const length =
    ["pnpm", "npm", "yarn", "bun"].includes(basename(argv[0] ?? "")) && argv[1] === "run" ? 3 : 2;
  const selected = argv.slice(0, length);
  if (selected.length !== length || selected.some((token) => !/^[A-Za-z0-9_./+-]+$/.test(token)))
    return;
  const prefix = selected.join(" ");
  return macPrefixMatches(prefix, command) ? prefix : undefined;
}
/** Ambiguous shell syntax and broad execution wrappers always require a command approval. */
export function macPrefixMatches(prefix: string, command: string): boolean {
  const rule = tokenizeCommand(prefix),
    actual = tokenizeCommand(command);
  if (!rule || !actual || rule.length < 2 || rule.length > actual.length) return false;
  const program = basename(rule[0] ?? "");
  // An option selector (git -C, open -a) does not name the operation being allowed.
  if (rule[1]?.startsWith("-") && program !== "uname") return false;
  if (
    wrappers.has(program) ||
    fresh.has(program) ||
    /^(?:python|ruby|perl|php|lua|tclsh|wish|node)(?:js)?[0-9.]*$/.test(program)
  )
    return false;
  if (["-c", "-e", "-f", "--eval", "--command", "--script", "--file"].includes(rule.at(-1) ?? ""))
    return false;
  if (actual.some((token) => fresh.has(basename(token)))) return false;
  // A package-manager execution verb alone covers unrelated commands/scripts.
  if (["pnpm", "npm", "yarn", "bun"].includes(program)) {
    if (["exec", "dlx", "x", "create"].includes(rule[1] ?? "")) return false;
    if (rule[1] === "run" && rule.length < 3) return false;
  }
  return rule.every((token, index) => token === actual[index]);
}
