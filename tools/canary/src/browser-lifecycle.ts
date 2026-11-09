import { readFileSync, writeFileSync } from "node:fs";
import { startDaemon } from "../../../packages/daemon/src/api.js";
import { browserApi } from "../../../packages/daemon/src/browser/api.js";
import { frozenBrowser } from "../../../packages/daemon/src/browser/evidence.js";
import { browserCommand } from "../../../packages/daemon/src/browser/runtime.js";
import { browserFixture } from "./browser-fixture.js";

const { root } = JSON.parse(readFileSync(".cache/browser-product-last.json", "utf8")) as {
  root: string;
};
const receipt = JSON.parse(readFileSync(`${root}/receipt.json`, "utf8")) as {
  tasks: { id: string; evidence: { generation: number; hash: string }[] }[];
};
const a = receipt.tasks[0],
  b = receipt.tasks[2];
if (!a || !b) throw Error("missing_native_tasks");
const fixture = await browserFixture(4);
const daemon = await startDaemon({ dataDir: root });
const api = browserApi(daemon.store, root);
try {
  const original = frozenBrowser(daemon.store, a.id);
  const beforeSession = daemon.store.snapshot(["session"]).session;
  await api("browser.action", { id: b.id, action: "open", confirmed: true, url: fixture.url });
  const reopened = (await api("browser.action", {
    id: a.id,
    action: "reopen_visible",
    confirmed: true,
    url: fixture.url,
  })) as { generation: number };
  const snapshot = await browserCommand(original.binding, ["snapshot"]);
  if (snapshot.includes("Submitted")) throw Error("web_write_replayed");
  if (reopened.generation < 2) throw Error("generation_not_incremented");
  await api("browser.action", { id: a.id, action: "stop", confirmed: true });
  const sibling = (await api("browser.task", { id: b.id })) as { health: string };
  if (sibling.health !== "running") throw Error("sibling_closed");
  if (JSON.stringify(beforeSession) !== JSON.stringify(daemon.store.snapshot(["session"]).session))
    throw Error("native_conversation_changed");
  const current = (await api("browser.task", { id: a.id })) as { evidence: { hash: string }[] };
  if (current.evidence[0]?.hash !== a.evidence[0]?.hash) throw Error("prior_evidence_changed");
  writeFileSync(
    ".cache/browser-lifecycle.json",
    JSON.stringify(
      {
        passed: true,
        root,
        generationAfter: reopened.generation,
        siblingUnaffected: true,
        noWebWriteReplay: true,
        sameNativeSessions: true,
        priorEvidenceRetained: true,
      },
      null,
      2,
    ),
  );
  console.log("Owned lifecycle: PASS");
} finally {
  for (const id of [a.id, b.id])
    await api("browser.action", { id, action: "stop", confirmed: true }).catch(() => {});
  await daemon.close();
  fixture.server.closeAllConnections();
  await new Promise<void>((r) => fixture.server.close(() => r()));
}
