import { StringDecoder } from "node:string_decoder";
import type { BoatApi } from "@boatdev/sdk";
import ssh2, { type ClientChannel } from "ssh2";
import { type ExecProcess, SandboxError } from "../../interface.js";
import { ExecChannel, shellJoin } from "../../stream.js";

// Boat's command API has no per-command env field and retains the command in history.
// Deliver the environment to a bootstrap over SSH stdin. The bootstrap only passes it to spawn.
const { Client, utils } = ssh2;

const bootstrap = `
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { argv, env, detached } = JSON.parse(fs.readFileSync(0, "utf8"));
const child = spawn(argv[0], argv.slice(1), {
  env: { ...process.env, ...env }, detached,
  stdio: detached ? "ignore" : ["ignore", "inherit", "inherit"]
});
child.once("error", error => { process.exitCode = error.code === "ENOENT" ? 127 : 126; });
if (detached) {
  child.once("spawn", () => child.unref());
} else {
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"])
    process.on(signal, () => child.kill(signal));
  child.once("exit", (code, signal) => {
    if (signal) {
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
    } else process.exitCode = code;
  });
}
`;

function transportError() {
  return new SandboxError("provider", "Boat SSH command failed");
}

export async function execWithEnvironment(
  api: Pick<BoatApi, "sshKey">,
  sandboxId: string,
  argv: string[],
  cwd: string,
  env: Record<string, string>,
  detached = false,
): Promise<ExecProcess> {
  const identity = utils.generateKeyPairSync("rsa", { bits: 2048 });
  // Only the public half is registered. The private half exists in this process.
  let connection: Awaited<ReturnType<BoatApi["sshKey"]>>;
  try {
    connection = await api.sshKey({ sandboxId, key: identity.public });
  } catch {
    throw transportError();
  }
  const endpoint = connection.sshEndpoint?.match(/^([^:]+):(\d+)$/);
  const host = endpoint?.[1] ?? connection.machineIp;
  const port = endpoint ? Number(endpoint[2]) : 22;
  const publicKey = connection.hostKey && utils.parseKey(connection.hostKey);
  if (!host || !port || !publicKey || publicKey instanceof Error || Array.isArray(publicKey))
    throw new SandboxError("provider", "Boat did not return an SSH endpoint and host key");
  const expected = publicKey.getPublicSSH();
  const client = new Client();
  const command = `cd -- ${shellJoin([cwd])} && exec ${shellJoin(["node", "-e", bootstrap])}`;

  let onDisconnect: () => void = () => undefined;
  const channel = await new Promise<ClientChannel>((resolve, reject) => {
    onDisconnect = () => reject(transportError());
    client.once("close", () => onDisconnect());
    client.on("error", () => onDisconnect());
    client.once("ready", () =>
      client.exec(command, (error, stream) => {
        if (error) {
          client.end();
          reject(transportError());
        } else resolve(stream);
      }),
    );
    try {
      client.connect({
        host,
        port,
        username: connection.sshUser ?? "user",
        privateKey: identity.private,
        algorithms: {
          serverHostKey:
            publicKey.type === "ssh-rsa" ? ["rsa-sha2-512", "rsa-sha2-256"] : [publicKey.type],
        },
        hostVerifier: (actual: Buffer) => expected.equals(actual),
        readyTimeout: 30_000,
        keepaliveInterval: 15_000,
      });
    } catch {
      reject(transportError());
    }
  });

  let finished = false;
  let killed = false;
  const output = new ExecChannel(async () => {
    if (finished || killed) return;
    channel.signal("TERM");
    killed = true;
  });
  onDisconnect = () => {
    if (!finished) output.error(transportError());
  };
  const stdout = new StringDecoder();
  const stderr = new StringDecoder();
  channel.on("data", (data: Buffer) => output.push("stdout", stdout.write(data)));
  channel.stderr.on("data", (data: Buffer) => output.push("stderr", stderr.write(data)));
  channel.on("error", onDisconnect);
  channel.once("close", (code: number | undefined) => {
    finished = true;
    output.push("stdout", stdout.end());
    output.push("stderr", stderr.end());
    output.end(killed ? { code: null, killed: true } : { code: code ?? null });
    client.end();
  });
  channel.end(JSON.stringify({ argv, env, detached }));
  return output;
}
