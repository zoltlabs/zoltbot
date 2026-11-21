// D10: a self-hosted daemon, run the way a Linux server runs it: headless, its saved logins in
// sealed files, talking to a relay. Starts the daemon as its own process and pairs through a
// test relay.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startRelay } from "../../services/relay/src/testing";

const root = path.resolve(import.meta.dirname, "../..");
let relay: Awaited<ReturnType<typeof startRelay>>;
let daemon: ChildProcess | undefined;
let folder: string;

async function until<T>(read: () => T | undefined, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > end) throw new Error("timed_out");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

beforeAll(async () => {
  mkdirSync(path.join(root, ".cache/tests"), { recursive: true });
  folder = mkdtempSync(path.join(root, ".cache/tests/self-host-"));
  relay = await startRelay();
  writeFileSync(path.join(folder, "secret.key"), randomBytes(32).toString("hex"), { mode: 0o600 });
});

afterAll(async () => {
  daemon?.kill("SIGTERM");
  await relay?.relay.close();
});

describe("self-hosted daemon (D10)", () => {
  it("starts headless, keeps logins out of its data, and pairs through a relay", async () => {
    const dataDir = path.join(folder, "data");
    const secretsDir = path.join(folder, "secrets");
    daemon = spawn(process.execPath, ["--import", "tsx", "packages/daemon/src/main.ts"], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: folder,
        TSX_DISABLE_CACHE: "1",
        ZOLTBOT_DATA_DIR: dataDir,
        ZOLTBOT_SECRETS_DIR: secretsDir,
        ZOLTBOT_SECRET_KEY_FILE: path.join(folder, "secret.key"),
        ZOLTBOT_RELAY_URL: relay.url,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    daemon.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const info = await until(() => {
      const file = path.join(dataDir, "daemon.json");
      return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
    }).catch((error) => {
      throw new Error(`${error}: ${stderr.slice(-2000)}`);
    });
    // It listens on this machine only; phones and desktops reach it through the relay.
    expect(info.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);

    // The pairing command prints a link, once the daemon's link to the relay is up.
    const pair = await until(() => {
      try {
        return execFileSync(
          process.execPath,
          ["scripts/zoltbot-pair.mjs", "--data-dir", dataDir, "--no-wait"],
          { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
        );
      } catch {
        return undefined;
      }
    });
    expect(pair).toMatch(/Open this link on the device to pair/);
    expect(pair).toMatch(/zoltbot:|https:/);

    // The daemon's identity went to the sealed files; its data folder holds only references.
    const sealed = readdirSync(secretsDir).filter((name) => name.endsWith(".secret"));
    expect(sealed.length).toBeGreaterThan(0);
    const database = readFileSync(path.join(dataDir, "zoltbot.db")).toString("latin1");
    expect(database).not.toMatch(/"(secretKey|privateKey)"\s*:/);

    daemon.kill("SIGTERM");
    await until(() => (daemon?.exitCode !== null ? true : undefined), 15_000);
    expect(existsSync(path.join(dataDir, "daemon.json"))).toBe(false);
  }, 90_000);

  it("install.sh writes a systemd unit with the server's settings", () => {
    const out = execFileSync(
      "bash",
      ["scripts/install.sh", "--dry-run", "--relay", "wss://relay.example.test"],
      { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH, HOME: folder } },
    );
    expect(out).toContain("[Service]");
    expect(out).toContain("Environment=ZOLTBOT_RELAY_URL=wss://relay.example.test");
    expect(out).toMatch(/Environment=ZOLTBOT_SECRET_KEY_FILE=.*\/\.config\/zoltbot\/secret\.key/);
    expect(out).toContain("UMask=0077");
    expect(out).toMatch(/ExecStart=\/usr\/bin\/env node .*zoltd\.mjs/);
    expect(out).toMatch(/^Environment="PATH=/m);
    expect(() =>
      execFileSync("bash", ["scripts/install.sh", "--dry-run", "--relay", "wss://a b%h"], {
        cwd: root,
        encoding: "utf8",
        stdio: "pipe",
        env: { PATH: process.env.PATH, HOME: folder },
      }),
    ).toThrow();
  });
});
