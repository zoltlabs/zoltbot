import { mkdir, readFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundleRuntime } from "../../scripts/bundle-runtime.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
process.chdir(root);
const directory = path.join(root, "apps/worker/dist");
await mkdir(directory, { recursive: true });
const { metafile } = await bundleRuntime(
  path.join(root, "apps/worker/src/main.ts"),
  path.join(directory, "main.mjs"),
  {
    base: directory,
    target: "node22",
    metafile: true,
  },
);
const manifest = JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8"));
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
for (const output of Object.values(metafile.outputs))
  for (const item of output.imports) {
    if (!item.external || builtins.has(item.path)) continue;
    const parts = item.path.split("/"),
      name = item.path.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
    if (!manifest.dependencies[name])
      throw new Error(`Worker bundle dependency is undeclared: ${name}`);
  }
process.stdout.write("Built zolt-worker for Node 22.\n");
