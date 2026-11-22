import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BoatApi } from "@boatdev/sdk";
import ssh2 from "ssh2";
import { expect, it, vi } from "vitest";
import { collect } from "../../stream.js";
import { execWithEnvironment } from "./ssh.js";

const { Server, utils } = ssh2;

it("sends per-command environment over authenticated SSH stdin and pins the host key", async () => {
  const key = utils.generateKeyPairSync("rsa", { bits: 2048 });
  let allowed: ReturnType<typeof utils.parseKey> | undefined;
  const commands: string[] = [];
  const server = new Server({ hostKeys: [key.private] }, (connection) => {
    connection.on("error", () => undefined);
    connection.on("authentication", (auth) => {
      if (
        auth.method === "publickey" &&
        allowed &&
        !(allowed instanceof Error) &&
        !Array.isArray(allowed) &&
        allowed.getPublicSSH().equals(auth.key.data) &&
        (!auth.signature ||
          (auth.blob && allowed.verify(auth.blob, auth.signature, auth.hashAlgo) === true))
      ) {
        auth.accept();
      } else auth.reject();
    });
    connection.on("ready", () => {
      connection.on("session", (accept) => {
        const session = accept();
        session.on("exec", (acceptCommand, _reject, { command }) => {
          commands.push(command);
          const channel = acceptCommand();
          const child = spawn("sh", ["-c", command], {
            env: { PATH: process.env.PATH },
            stdio: "pipe",
          });
          channel.pipe(child.stdin);
          child.stdout.pipe(channel, { end: false });
          child.stderr.pipe(channel.stderr, { end: false });
          child.once("close", (code) => {
            channel.exit(code ?? 1);
            channel.end();
          });
          channel.once("close", () => child.kill());
        });
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const endpoint = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const response = { ok: true, type: "fixture", sshEndpoint: endpoint, hostKey: key.public };
  const sshKey = vi.fn<BoatApi["sshKey"]>(async (request) => {
    const { key } = "sshKeyRequest" in request ? request.sshKeyRequest : request;
    const parsed = utils.parseKey(key);
    if (parsed instanceof Error || Array.isArray(parsed)) throw new Error("Invalid fixture key");
    allowed = parsed;
    return response;
  });
  const root = await mkdtemp(join(tmpdir(), "boat-ssh-test-"));
  try {
    const value = "synthetic-ssh-env-'fixture'";
    const process = await execWithEnvironment(
      { sshKey },
      "fixture",
      ["sh", "-c", 'printf "%s" "$ZOLT_ENV"; printf "err" >&2; exit 3'],
      "/tmp",
      { ZOLT_ENV: value },
    );
    expect(await collect(process)).toEqual({ stdout: value, stderr: "err", code: 3 });
    expect(commands).toHaveLength(1);
    expect(commands[0]).not.toContain(value);

    sshKey.mockResolvedValueOnce({
      ...response,
      hostKey: utils.generateKeyPairSync("rsa", { bits: 2048 }).public,
    });
    await expect(
      execWithEnvironment({ sshKey }, "fixture", ["true"], "/tmp", { ZOLT_ENV: value }),
    ).rejects.toThrow("Boat SSH command failed");
    expect(commands).toHaveLength(1);

    const marker = join(root, "worker-finished");
    const started = await execWithEnvironment(
      { sshKey },
      "fixture",
      ["sh", "-c", 'sleep 1 && printf ready > "$1"', "fixture", marker],
      root,
      { ZOLT_ENV: value },
      true,
    );
    expect(await collect(started)).toEqual({ stdout: "", stderr: "", code: 0 });
    await expect
      .poll(() => readFile(marker, "utf8").catch(() => ""), { timeout: 4000 })
      .toBe("ready");
    expect(commands[1]).not.toContain(value);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
