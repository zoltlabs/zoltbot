import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const binary = require("../apps/desktop/node_modules/electron");
const root = process.cwd();
const temporary = path.join(root, ".cache/tmp");
mkdirSync(temporary, { recursive: true });
const env = {
  ...process.env,
  TMPDIR: temporary,
  ZOLTBOT_REPO_ROOT: root,
  ZOLTBOT_NODE_BINARY: process.execPath,
};
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(binary, [path.join(root, ".cache/desktop/main.cjs")], {
  cwd: root,
  stdio: "inherit",
  env,
});
child.once("error", () => {
  process.exitCode = 1;
});
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
