/** Synthetic daemon for the headless terminal preview; no provider or user session data. */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { handle } from "@zoltbot/core";
import { startDaemon } from "../../../packages/daemon/src/api.js";
import { at, runtimeFixture } from "./runtime-fixture.js";

const fixture = await runtimeFixture("zoltbot.db");
fixture.store.dispatch("allow", (state) =>
  handle(
    state,
    {
      type: "update",
      kind: "agent",
      id: "profile",
      changes: { permissionProfile: "workspace_write" },
      confirmed: true,
    },
    { commandId: "allow", at, actor: { kind: "human", id: "fixture" } },
  ),
);
fixture.store.close();
process.env.HOME = fixture.root;
process.env.SHELL = "/bin/sh";
const daemon = await startDaemon({ dataDir: fixture.root, origins: ["http://127.0.0.1:5198"] });
const file = path.resolve(".cache/terminal-smoke/connection.json");
mkdirSync(path.dirname(file), { recursive: true });
writeFileSync(file, JSON.stringify({ url: daemon.url, token: daemon.token }), { mode: 0o600 });
console.log("Synthetic terminal daemon ready");
process.once("SIGTERM", () => {
  void daemon.close().finally(() => {
    fixture.close();
    rmSync(file, { force: true });
    process.exit();
  });
});
