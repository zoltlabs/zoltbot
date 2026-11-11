import { serveView } from "../tools/view-dev/src/server.ts";

if (process.argv.length !== 3) throw Error("Usage: pnpm view:dev <view-folder>");
const server = await serveView(process.argv[2]);
console.log(`View preview: ${server.url}`);
console.log("Sample data only. Reload the browser after editing files.");
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    void server.close().then(() => process.exit(0));
  });
