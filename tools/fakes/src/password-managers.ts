// V3: stand-ins for the 1Password, Bitwarden and Proton Pass CLIs. Each answers the commands the
// daemon's adapters send, in the shape the real tool prints, from synthetic items.
/** The shape of `@zoltbot/detect`'s command runner, which the daemon's adapters call. */
type CommandRunner = (
  command: string,
  args: string[],
  options: { env?: Record<string, string> },
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

export interface FakeManagerItem {
  id: string;
  title: string;
  username?: string;
  password: string;
  urls: string[];
}

export interface FakeManagers {
  /** Which CLIs are installed, and whether each is signed in or unlocked. */
  installed: Partial<Record<"op" | "bw" | "pass-cli", "ready" | "locked" | "signed_out">>;
  items: FakeManagerItem[];
  /** Bitwarden's session key; `bw` answers as unlocked when it is set in BW_SESSION. */
  bitwardenSession?: string;
}

/** A ProviderHost backed by fake CLIs; `calls` records each command without its environment. */
export function fakePasswordManagers(state: FakeManagers) {
  const calls: string[][] = [];
  /** Whether each `bw` call carried a session key. */
  const sessions: boolean[] = [];
  /** Each CLI's identity; `replace` stands in for a different program at the same path. */
  const programs: Record<string, string> = {};
  const reply = (stdout: unknown, code = 0) => ({
    code,
    stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout),
    stderr: "",
  });
  const find = (id: string) => state.items.find((item) => item.id === id);
  const run: CommandRunner = async (command, args, options) => {
    const binary = command.split("/").pop() as "op" | "bw" | "pass-cli";
    calls.push([binary, ...args]);
    if (binary === "bw") sessions.push(!!options.env?.BW_SESSION);
    const status = state.installed[binary];
    if (binary === "op") {
      if (status !== "ready") return reply("", 1);
      if (args[0] === "whoami") return reply({ email: "owner@example.test" });
      if (args[1] === "list")
        return reply(
          state.items.map((item) => ({
            id: item.id,
            title: item.title,
            additional_information: item.username,
            urls: item.urls.map((href) => ({ href })),
          })),
        );
      const item = find(args[2] ?? "");
      if (!item) return reply("", 1);
      return reply([
        { id: "username", label: "username", value: item.username ?? "" },
        { id: "password", label: "password", value: item.password },
      ]);
    }
    if (binary === "bw") {
      const unlocked =
        status === "ready" ||
        (status === "locked" &&
          !!state.bitwardenSession &&
          options.env?.BW_SESSION === state.bitwardenSession);
      if (args[0] === "status")
        return reply({
          status: unlocked ? "unlocked" : status === "locked" ? "locked" : "unauthenticated",
        });
      if (!unlocked) return reply("", 1);
      const whole = (item: FakeManagerItem) => ({
        id: item.id,
        type: 1,
        name: item.title,
        login: {
          username: item.username,
          password: item.password,
          uris: item.urls.map((uri) => ({ uri })),
        },
      });
      if (args[0] === "list") return reply(state.items.map(whole));
      const item = find(args[2] ?? "");
      return item ? reply(whole(item)) : reply("", 1);
    }
    if (status !== "ready") return reply("", 1);
    if (args[0] === "info") return reply({ user: "owner" });
    if (args[1] === "list")
      return reply(
        state.items.map((item) => ({
          id: item.id,
          title: item.title,
          content: { username: item.username, urls: item.urls },
        })),
      );
    const item = find(args[3] ?? "");
    return item
      ? reply({ id: item.id, content: { username: item.username, password: item.password } })
      : reply("", 1);
  };
  return {
    calls,
    sessions,
    replace(binary: string) {
      programs[binary] = `/fake/bin/${binary}:replaced`;
    },
    host: {
      async identify(file: string) {
        const binary = file.split("/").pop() ?? "";
        return programs[binary] ?? `${file}:original`;
      },
      async find(binary: string) {
        return state.installed[binary as keyof FakeManagers["installed"]]
          ? `/fake/bin/${binary}`
          : undefined;
      },
      run,
    },
  };
}
