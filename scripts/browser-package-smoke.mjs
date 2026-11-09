import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { bundleRuntime } from "./bundle-runtime.mjs";

// Disposable asar:false resource-layout smoke. Never signs, publishes or modifies the installed app.
const stage = path.resolve(`.cache/browser-package-smoke-${Date.now()}`);
mkdirSync(path.join(stage, "bin"), { recursive: true });
mkdirSync(path.join(stage, "node_modules"), { recursive: true });
cpSync(process.execPath, path.join(stage, "bin/node"));
const require = createRequire(path.resolve("packages/daemon/package.json"));
for (const name of ["@playwright/cli", "playwright", "playwright-core"]) {
  const scoped =
    name === "@playwright/cli"
      ? require
      : createRequire(require.resolve("@playwright/cli/package.json"));
  const from = path.dirname(scoped.resolve(`${name}/package.json`));
  cpSync(from, path.join(stage, "node_modules", name), { recursive: true, dereference: true });
}
await bundleRuntime("packages/daemon/src/browser/runtime.ts", path.join(stage, "runtime.mjs"), {
  base: process.cwd(),
});
const cache = path.resolve(process.argv[2] ?? ".cache/browser-spike/browsers");
if (!existsSync(cache))
  throw Error("Install the pinned fixture browser first; no implicit downloads in smoke test.");
const data = path.join(stage, "user-data");
mkdirSync(path.join(data, "browser"), { recursive: true });
symlinkSync(cache, path.join(data, "browser/browsers"));
writeFileSync(
  path.join(stage, "smoke.mjs"),
  `import {browserBinding,browserCommand,browserReadiness} from './runtime.mjs';\nconst data=${JSON.stringify(data)};const readiness=await browserReadiness(data);if(readiness.state!=='ready')throw Error(JSON.stringify(readiness));const b=browserBinding(data,data,{mode:'background'});try {const version=await browserCommand(b,['--version']);await browserCommand(b,['open','about:blank']);await browserCommand(b,['snapshot']);console.log(JSON.stringify({readiness,version:version.trim(),node:process.execPath,cliPackaged:true,path:process.env.PATH,navigationProbe:'passed'}));}finally{await browserCommand(b,['close']);}\n`,
);
const output = execFileSync(path.join(stage, "bin/node"), [path.join(stage, "smoke.mjs")], {
  cwd: stage,
  env: { PATH: "/usr/bin:/bin", HOME: path.join(stage, "isolated-home"), TMPDIR: "/tmp" },
  encoding: "utf8",
  timeout: 60000,
});
writeFileSync(path.join(stage, "receipt.json"), output);
writeFileSync(
  path.resolve(".cache/browser-package-last.json"),
  JSON.stringify({ stage, receipt: JSON.parse(output) }, null, 2),
);
console.log(output);
// Retain this disposable stage and receipt for review; no global runtime discovery was used.
