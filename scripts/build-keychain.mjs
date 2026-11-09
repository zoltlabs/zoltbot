import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";

if (process.platform !== "darwin") {
  if (!process.argv.includes("--check")) throw new Error("keychain_requires_macos");
  console.log("Keychain compilation targets macOS. Private transport tests run on every platform.");
} else {
  const root = process.cwd(),
    cache = path.join(root, ".cache");
  for (const directory of [
    "native",
    "swift-modules",
    "native-tmp",
    "tooling-home",
    "tooling-cache",
  ])
    mkdirSync(path.join(cache, directory), { recursive: true, mode: 0o700 });
  const output = path.join(cache, "native", `keychain-${randomUUID()}`);
  try {
    const result = spawnSync(
      "/usr/bin/swiftc",
      [
        "-module-cache-path",
        path.join(cache, "swift-modules"),
        path.join(root, "packages/daemon/native/keychain.swift"),
        "-o",
        output,
      ],
      {
        cwd: root,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: path.join(cache, "tooling-home"),
          CFFIXED_USER_HOME: path.join(cache, "tooling-home"),
          TMPDIR: path.join(cache, "native-tmp"),
          XDG_CACHE_HOME: path.join(cache, "tooling-cache"),
          CLANG_MODULE_CACHE_PATH: path.join(cache, "swift-modules"),
        },
        stdio: "inherit",
        timeout: 60000,
      },
    );
    if (result.error || result.status !== 0) throw new Error("keychain_build_failed");
    chmodSync(output, 0o700);
    renameSync(output, path.join(cache, "native", "zoltbot-keychain"));
    console.log("Compiled Keychain helper without accessing Keychain.");
  } finally {
    rmSync(output, { force: true });
  }
}
