import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// R5: the zolt command as one self-contained file. The packaged app runs it with its own Node.
const root = fileURLToPath(new URL("../../", import.meta.url));
const outfile = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(root, "apps/cli/dist/zolt.mjs");
await mkdir(path.dirname(outfile), { recursive: true });
await build({
  entryPoints: [path.join(root, "apps/cli/src/main.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // ws's optional speedups; it works without them.
  external: ["bufferutil", "utf-8-validate"],
  // ws is CommonJS and requires Node built-ins.
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
});
await chmod(outfile, 0o755);
process.stdout.write(`Built zolt for Node 22 at ${path.relative(root, outfile)}.\n`);
