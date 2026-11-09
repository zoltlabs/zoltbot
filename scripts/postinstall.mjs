import { chmodSync, globSync } from "node:fs";

// node-pty's shipped macOS helper can lose its executable bit during a clean install.
// This only repairs installed dependency files; it never launches the helper.
if (process.platform === "darwin") {
  for (const helper of globSync(
    "node_modules/.pnpm/node-pty@*/node_modules/node-pty/prebuilds/darwin-*/spawn-helper",
  ))
    chmodSync(helper, 0o755);
}
