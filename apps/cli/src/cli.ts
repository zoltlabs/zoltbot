// R5: the zolt command. It talks to the Zoltbot daemon already running on this Mac, using the
// same local address and token the desktop app reads.
import { DaemonClient, defaultDataDir, readConnection } from "@zoltbot/daemon-client";
import { ask, type ExitCode, type Output, status, tail, task, UsageError } from "./commands.js";

const HELP = `Usage:
  zolt status                         Chats, what's working, and what needs you
  zolt ask <chat or agent> "…"        Send a message and print the reply
  zolt task <agent> "…" [--wait]      Start a task; --wait follows it to the end
  zolt tail <chat or agent>           Print a chat's messages as they arrive

An agent's name means that agent's most recent chat:
  zolt ask Ada "What changed in the build today?"

Options:
  --json           One JSON object per line, for scripts
  --timeout <s>    Stop waiting after this many seconds; the default is 600
  --               Everything after this is the message, even words starting with --

Exit codes: 0 done, 1 failed, 2 needs you.`;

export function parseArgs(argv: readonly string[]) {
  const flags = {
    json: false,
    wait: false,
    help: false,
    timeoutMs: undefined as number | undefined,
  };
  const words: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const raw = argv[index] as string;
    if (raw === "--") {
      words.push(...argv.slice(index + 1));
      break;
    }
    const [arg, inline] = raw.startsWith("--") && raw.includes("=") ? raw.split(/=(.*)/s) : [raw];
    if (arg === "--json") flags.json = true;
    else if (arg === "--wait") flags.wait = true;
    else if (arg === "--help" || arg === "-h") flags.help = true;
    else if (arg === "--timeout") {
      const seconds = Number(inline ?? argv[++index]);
      if (!Number.isFinite(seconds) || seconds <= 0)
        throw new UsageError("--timeout takes a number of seconds.");
      flags.timeoutMs = seconds * 1000;
    } else if (raw.startsWith("--")) throw new UsageError(`Unknown option ${arg}.`);
    else words.push(raw);
  }
  return { ...flags, command: words[0], args: words.slice(1) };
}

export async function run(argv: readonly string[]): Promise<ExitCode> {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (!parsed.command) {
    process.stderr.write(`${HELP}\n`);
    return 1;
  }
  const output: Output = {
    json: parsed.json,
    write: (line) => process.stdout.write(`${line}\n`),
    note: (line) => process.stderr.write(`${line}\n`),
  };
  const dataDir = defaultDataDir();
  const client = new DaemonClient(async () => {
    const info = readConnection(dataDir);
    if (!info) throw new Error("not running");
    return info;
  });
  await client.start();
  if (client.status !== "online") {
    client.stop();
    throw new Error("Zoltbot isn't running. Open the app, then try again.");
  }
  const daemon = {
    call: (method: string, params: unknown, commandId?: string) =>
      client.call(method, params, commandId),
    rows: (kind: string) => client.rows(kind),
    onChange: (listener: () => void) => client.onChange(listener),
  };
  const [name = "", ...rest] = parsed.args;
  try {
    switch (parsed.command) {
      case "status":
        return await status(daemon, output);
      case "ask":
        return await ask(daemon, output, name, rest.join(" "), parsed.timeoutMs);
      case "task":
        return await task(daemon, output, name, rest.join(" "), parsed);
      case "tail": {
        tail(daemon, output, name);
        // Runs until Ctrl-C.
        await new Promise<void>((done) => process.once("SIGINT", () => done()));
        return 0;
      }
      default:
        throw new UsageError(`Unknown command ${parsed.command}. Run "zolt --help".`);
    }
  } finally {
    client.stop();
  }
}
