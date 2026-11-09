import { build } from "esbuild";
import { bundleRuntime } from "./bundle-runtime.mjs";

await build({
  entryPoints: ["apps/desktop/src/main.ts", "apps/desktop/src/preload.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron"],
  outdir: ".cache/desktop",
  outExtension: { ".js": ".cjs" },
});
await bundleRuntime("packages/daemon/src/main.ts", ".cache/desktop/daemon.mjs");
if (process.argv.includes("--fixtures")) {
  for (const name of ["chat", "doctor", "desktop", "devices", "browser", "artifacts", "knowledge"])
    await bundleRuntime(
      `tools/fakes/src/${name}-daemon.ts`,
      `.cache/desktop/fixtures/${name}-daemon.mjs`,
    );
}
