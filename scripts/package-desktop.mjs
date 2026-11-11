import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  globSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { Arch, build, Platform } from "electron-builder";
import { bundleRuntime } from "./bundle-runtime.mjs";

// Builds dist/release/Zoltbot-<version>-<arch>.dmg. The app folder holds the desktop bundle,
// the daemon bundle with its installed dependencies and source-relative resources, the built
// UI, and a Node runtime of the same version as this one for the daemon (D125).
//   --unsigned  ad-hoc signature, for local testing only; Gatekeeper blocks it once downloaded
//   --arm64     Apple silicon only, instead of a universal build
// ZOLTBOT_HOSTED_ORIGIN names the accounts and integrations origin a release uses (official
// builds: https://zoltbot.ai). Signed builds must set it, or set it to "none" to ship without.
// ZOLTBOT_RELAY_URL optionally names the phone relay (official builds: wss://relay.zoltbot.ai).

if (process.platform !== "darwin") throw new Error("package_requires_macos");
if (Number(process.versions.node.split(".")[0]) !== 24)
  throw new Error("Desktop packaging requires Node 24 so the bundled runtime matches the app.");
const root = process.cwd();
const unsigned = process.argv.includes("--unsigned");
const arch = process.argv.includes("--arm64") ? Arch.arm64 : Arch.universal;
const work = path.join(root, ".cache/package");
const stage = path.join(work, "app");
const json = (file) => JSON.parse(readFileSync(path.join(root, file), "utf8"));
const run = (command, args, cwd = root) => {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
};

const signing = signingPlan();
const hostedOrigin = hostedServiceOrigin();
const relayUrl = process.env.ZOLTBOT_RELAY_URL;
if (relayUrl && !/^wss:\/\/[^\s/]+$/.test(relayUrl))
  throw new Error("ZOLTBOT_RELAY_URL must be a wss:// host, such as wss://relay.zoltbot.ai.");
rmSync(stage, { recursive: true, force: true });
mkdirSync(path.join(stage, "bin"), { recursive: true });

run("pnpm", ["build:desktop"]);
run("pnpm", ["build:ui"]);
for (const name of ["main.cjs", "preload.cjs"])
  cpSync(path.join(root, ".cache/desktop", name), path.join(stage, name));
cpSync(path.join(root, "dist/ui"), path.join(stage, "ui"), { recursive: true });
cpSync(path.join(root, "apps/desktop/assets/zoltbot.png"), path.join(stage, "zoltbot.png"));

// Workspace files the daemon reads next to its source, at the same relative paths.
const { metafile } = await bundleRuntime(
  "packages/daemon/src/main.ts",
  path.join(stage, "daemon.mjs"),
  { base: root, metafile: true },
);
for (const resource of [
  "docs/third-party/t3-terminal-MIT.txt",
  "docs/third-party/t3-composer-MIT.txt",
  "packages/store/migrations",
  "packages/adapters/pi/src/extension.ts",
  "packages/artifact-kit/v1",
  "packages/views",
  "packages/view-api/client",
  "packages/skills/builtin",
])
  cpSync(path.join(root, resource), path.join(stage, resource), { recursive: true });

writeFileSync(
  path.join(stage, "package.json"),
  `${JSON.stringify(
    {
      name: "zoltbot",
      productName: "Zoltbot",
      version: json("package.json").version,
      description: "Run your coding agents as a team",
      author: "Zolt Labs LLC",
      main: "main.cjs",
      ...(hostedOrigin || relayUrl
        ? {
            zoltbot: {
              ...(hostedOrigin ? { hostedOrigin } : {}),
              ...(relayUrl ? { relayUrl } : {}),
            },
          }
        : {}),
      dependencies: externalDependencies(metafile),
    },
    null,
    2,
  )}\n`,
);
run("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], stage);
// npm's ignored install scripts leave node-pty's spawn helper non-executable.
for (const helper of globSync("node_modules/node-pty/prebuilds/darwin-*/spawn-helper", {
  cwd: stage,
}))
  chmodSync(path.join(stage, helper), 0o755);
// Dependencies can include iOS, Linux and Windows prebuilds. Ship only the Mac slices.
for (const entry of globSync("node_modules/**/prebuilds/*", { cwd: stage }))
  if (!path.basename(entry).startsWith("darwin-"))
    rmSync(path.join(stage, entry), { recursive: true, force: true });
// The Agent SDK drives the person's own Claude Code, so its bundled per-platform binaries are unused.
for (const entry of globSync("node_modules/@anthropic-ai/claude-agent-sdk-*", { cwd: stage }))
  rmSync(path.join(stage, entry), { recursive: true, force: true });
keychainHelper(path.join(stage, "bin/zoltbot-keychain"));
speechHelper(path.join(stage, "bin/zoltbot-speech"));

const electron = json("apps/desktop/package.json").dependencies.electron;
await build({
  publish: "never",
  targets: Platform.MAC.createTarget("dmg", arch),
  config: {
    appId: "ai.zoltbot.desktop",
    productName: "Zoltbot",
    copyright: "Copyright © 2026 Zolt Labs LLC",
    electronVersion: electron,
    directories: { app: stage, output: path.join(root, "dist/release") },
    asar: false,
    npmRebuild: false,
    nodeGypRebuild: false,
    protocols: [{ name: "Zoltbot", schemes: ["zoltbot"] }],
    mac: {
      category: "public.app-category.developer-tools",
      icon: path.join(root, "apps/desktop/assets/zoltbot.png"),
      minimumSystemVersion: "13.0",
      // Dependencies ship both slices in architecture-named folders; preserve each as-is.
      x64ArchFiles: "**/prebuilds/darwin-{arm64,x64}/**",
      hardenedRuntime: true,
      entitlements: path.join(root, "apps/desktop/build/entitlements.mac.plist"),
      entitlementsInherit: path.join(root, "apps/desktop/build/entitlements.mac.plist"),
      extendInfo: {
        NSMicrophoneUsageDescription:
          "Zoltbot uses your microphone when you hold to dictate a message or task brief.",
        NSSpeechRecognitionUsageDescription:
          "Zoltbot uses macOS Speech Recognition to transcribe your spoken messages into editable text.",
      },
      ...(signing.identity ? { identity: signing.identity } : {}),
      notarize: signing.notarize,
    },
    // biome-ignore lint/suspicious/noTemplateCurlyInString: electron-builder fills these in.
    dmg: { artifactName: "${productName}-${version}-${arch}.${ext}" },
    afterPack: addArchitectureFiles,
    publish: null,
  },
});

/** Each architecture gets its own Node and SQLite binding; the universal step merges them. */
async function addArchitectureFiles(context) {
  const name = Arch[context.arch];
  if (name === "universal") return;
  const app = path.join(context.appOutDir, "Zoltbot.app/Contents/Resources/app");
  cpSync(await nodeRuntime(name), path.join(app, "bin/node"));
  const binding = path.join(app, "node_modules/better-sqlite3/build/Release");
  mkdirSync(binding, { recursive: true });
  cpSync(await sqliteBinding(name), path.join(binding, "better_sqlite3.node"));
}

function signingPlan() {
  if (unsigned) return { identity: "-", notarize: false };
  const identities = execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], {
    encoding: "utf8",
  });
  if (!process.env.CSC_LINK && !identities.includes("Developer ID Application"))
    throw new Error(
      "No Developer ID Application certificate. Install one (docs/releasing.md) or pass --unsigned.",
    );
  const notary =
    (process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER) ||
    (process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID);
  if (!notary)
    throw new Error("Notarization needs APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER.");
  return { identity: undefined, notarize: true };
}

function hostedServiceOrigin() {
  const value = process.env.ZOLTBOT_HOSTED_ORIGIN;
  if (!value) {
    if (unsigned) return undefined;
    throw new Error(
      'Signed builds need ZOLTBOT_HOSTED_ORIGIN (https://zoltbot.ai for official builds, or "none").',
    );
  }
  if (value === "none") return undefined;
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value)
    throw new Error("ZOLTBOT_HOSTED_ORIGIN must be an https origin, such as https://zoltbot.ai.");
  return value;
}

/** Pinned versions of the installed packages the daemon bundle imports. */
function externalDependencies(meta) {
  const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
  const pinned = {};
  for (const directory of ["packages", "packages/adapters", "apps"])
    for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
      const file = path.join(root, directory, entry.name, "package.json");
      if (!entry.isDirectory() || !existsSync(file)) continue;
      for (const [name, version] of Object.entries(
        JSON.parse(readFileSync(file, "utf8")).dependencies ?? {},
      ))
        if (!String(version).startsWith("workspace:")) pinned[name] = version;
    }
  // Packages only read as resources (import.meta.resolve) are not imports, so the sources name them.
  const specifiers = Object.values(meta.outputs).flatMap((output) =>
    output.imports.filter((item) => item.external).map((item) => item.path),
  );
  for (const input of Object.keys(meta.inputs))
    if (/\.tsx?$/.test(input))
      for (const match of readFileSync(path.join(root, input), "utf8").matchAll(
        /import\.meta\.resolve\("([^"]+)"\)/g,
      ))
        specifiers.push(match[1]);
  const needed = {};
  for (const specifier of specifiers) {
    if (builtins.has(specifier)) continue;
    const parts = specifier.split("/");
    const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
    if (!pinned[name]) throw new Error(`Daemon imports ${name}, which no workspace package pins`);
    needed[name] = pinned[name];
  }
  return Object.fromEntries(Object.entries(needed).sort());
}

/** The official Node build matching this runtime, checked against its published checksums. */
async function nodeRuntime(name) {
  const version = process.versions.node;
  const target = path.join(work, "node", `${version}-${name}`, "node");
  if (existsSync(target)) return target;
  const archive = `node-v${version}-darwin-${name}.tar.gz`;
  const base = `https://nodejs.org/dist/v${version}`;
  const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text();
  const expected = sums
    .split("\n")
    .find((line) => line.endsWith(`  ${archive}`))
    ?.split(" ")[0];
  const bytes = Buffer.from(await (await fetch(`${base}/${archive}`)).arrayBuffer());
  if (!expected || createHash("sha256").update(bytes).digest("hex") !== expected)
    throw new Error(`Checksum mismatch for ${archive}`);
  return extract(bytes, `node-v${version}-darwin-${name}/bin/node`, target);
}

/** The better-sqlite3 prebuild for this Node ABI, from the project's own release. */
async function sqliteBinding(name) {
  const version = json("packages/store/package.json").dependencies["better-sqlite3"];
  const abi = process.versions.modules;
  const target = path.join(work, "sqlite", `${version}-node${abi}-${name}`, "better_sqlite3.node");
  if (existsSync(target)) return target;
  const archive = `better-sqlite3-v${version}-node-v${abi}-darwin-${name}.tar.gz`;
  const response = await fetch(
    `https://github.com/WiseLibs/better-sqlite3/releases/download/v${version}/${archive}`,
  );
  if (!response.ok) throw new Error(`No better-sqlite3 prebuild ${archive}`);
  return extract(
    Buffer.from(await response.arrayBuffer()),
    "build/Release/better_sqlite3.node",
    target,
  );
}

function extract(bytes, member, target) {
  const directory = path.dirname(target);
  const archive = path.join(directory, "download.tar.gz");
  mkdirSync(directory, { recursive: true });
  writeFileSync(archive, bytes);
  run("tar", [
    "-xzf",
    archive,
    "-C",
    directory,
    "--strip-components",
    String(member.split("/").length - 1),
    member,
  ]);
  rmSync(archive);
  return target;
}

/** The Keychain helper for both architectures, compiled like scripts/build-keychain.mjs. */
function keychainHelper(target) {
  compileSwiftHelper("packages/daemon/native/keychain.swift", "keychain", target);
}

/** The speech recognition helper for both architectures, compiled like scripts/build-speech.mjs. */
function speechHelper(target) {
  compileSwiftHelper("apps/desktop/native/speech.swift", "speech", target);
}

function compileSwiftHelper(sourceFile, prefix, target) {
  const cache = path.join(root, ".cache");
  for (const directory of ["swift-modules", "native-tmp", "tooling-home", "tooling-cache"])
    mkdirSync(path.join(cache, directory), { recursive: true, mode: 0o700 });
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: path.join(cache, "tooling-home"),
    CFFIXED_USER_HOME: path.join(cache, "tooling-home"),
    TMPDIR: path.join(cache, "native-tmp"),
    XDG_CACHE_HOME: path.join(cache, "tooling-cache"),
    CLANG_MODULE_CACHE_PATH: path.join(cache, "swift-modules"),
  };
  const slices = ["arm64", "x86_64"].map((cpu) => {
    const output = path.join(work, `${prefix}-${cpu}`);
    execFileSync(
      "/usr/bin/swiftc",
      [
        "-target",
        `${cpu}-apple-macos13`,
        "-module-cache-path",
        path.join(cache, "swift-modules"),
        path.join(root, sourceFile),
        "-o",
        output,
      ],
      { cwd: root, env, stdio: "inherit", timeout: 120000 },
    );
    return output;
  });
  execFileSync("/usr/bin/lipo", ["-create", ...slices, "-output", target]);
}
