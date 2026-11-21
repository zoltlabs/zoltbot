// D10: builds the daemon on its own, for a server with no desktop app. The bundle runs from this
// checkout, which keeps the installed dependencies it loads.
//
//   node scripts/build-daemon.mjs        # writes dist/daemon/zoltd.mjs
import { bundleRuntime } from "./bundle-runtime.mjs";

await bundleRuntime("packages/daemon/src/main.ts", "dist/daemon/zoltd.mjs");
process.stdout.write("Built dist/daemon/zoltd.mjs\n");
