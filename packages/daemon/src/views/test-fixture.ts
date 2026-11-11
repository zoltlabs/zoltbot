import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openStore } from "@zoltbot/store";
import { ViewRegistry } from "./registry.js";
export async function viewFixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "view-fixture-"))),
    builtin = path.join(root, "builtin");
  await mkdir(path.join(builtin, "example"), { recursive: true });
  await writeFile(
    path.join(builtin, "example", "view.json"),
    JSON.stringify({
      manifest: 1,
      id: "example",
      name: "Example",
      version: "1.0.0",
      api: 1,
      entry: "index.html",
      slots: ["page"],
      permissions: ["read", "act", "approve"],
    }),
  );
  await writeFile(path.join(builtin, "example", "index.html"), "<h1>Example</h1>");
  const store = await openStore(path.join(root, "zoltbot.db"));
  const registry = new ViewRegistry(store, builtin, path.join(root, "views"), () => {});
  await registry.reload();
  return {
    root,
    builtin,
    store,
    registry,
    async close() {
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
