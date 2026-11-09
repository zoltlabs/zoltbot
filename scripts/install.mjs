import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const temporary = path.join(root, ".cache/tmp");
mkdirSync(temporary, { recursive: true });
const child = spawn("pnpm", ["install", ...process.argv.slice(2)], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    TMPDIR: temporary,
    electron_config_cache: path.join(root, ".cache/electron"),
  },
});
child.once("error", () => {
  process.exitCode = 1;
});
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
