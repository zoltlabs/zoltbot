import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { createServer } from "node:http";
import path from "node:path";
import { codexDefinitions } from "../../../packages/adapters/codex/src/definitions.js";
import {
  browserBinding,
  browserCommand,
  materializeBrowser,
} from "../../../packages/daemon/src/browser/runtime.js";
import { Redactor } from "../../../packages/daemon/src/logging.js";
import { providerHosts } from "../../../packages/daemon/src/provider-hosts.js";
import type { AgentEvent } from "../../../packages/protocol/src/index.js";
import { hostMcpFixture } from "../../fakes/src/host-mcp-fixture.js";
import { browserFixture } from "./browser-fixture.js";

mkdirSync(".cache", { recursive: true });
const root = mkdtempSync(path.resolve(".cache/browser-shared-"));
const hosts = providerHosts({ directory: root });
const mcp = await hostMcpFixture();
const redactor = new Redactor([mcp.token]);
const adapter = hosts.adapters(redactor).get("codex");
if (!adapter) throw Error("adapter");
const source = codexDefinitions[0];
if (!source) throw Error("definition");
const definition = await hosts.definition(source);
const jobs = [];
const servers: ReturnType<typeof createServer>[] = [];
try {
  for (let index = 1; index <= 2; index++) {
    const directory = path.join(root, `task-${index}`);
    mkdirSync(directory);
    const fixture = await browserFixture(index);
    const { expected, url, server } = fixture;
    servers.push(server);
    const b = browserBinding(root, directory, {
      mode: "background",
      url,
    });
    b.browsers = path.resolve(".cache/browser-spike/browsers");
    materializeBrowser(b);
    const native = await adapter.open(definition, {
      identity: { agentId: "canary", threadId: `task-${index}` },
      mode: "new",
      cwd: directory,
      permissionProfile: "workspace_write",
      hostMcp: { url: mcp.url, token: mcp.token },
    });
    const trace: AgentEvent[] = [];
    let done = false;
    const reading = (async () => {
      for await (const event of native.events()) {
        trace.push(event);
        if (event.t === "interaction.requested")
          await native.respond(event.interaction.nativeRef ?? event.interaction.id, {
            action: "accept",
            choice: "allow_once",
            by: { kind: "human", id: "local-browser-canary" },
            at: new Date().toISOString(),
          });
        if (event.t === "turn.done") done = true;
      }
    })();
    jobs.push({ index, b, native, trace, reading, expected, done: () => done });
  }
  await Promise.all(
    jobs.map(async (job) => {
      await job.native.send(
        [
          {
            type: "text",
            text: `Use ${job.b.launcher} open ${job.b.url}, snapshot, fill Alias with fake-test, click Submit, screenshot --filename=${job.b.artifactRoot}/capture.png. Inspect the PNG with your native image tool and report the visual digits and whether Submitted appears. Use only the local fixture. Do not inspect other files, visit external sites or use eval/run-code to extract pixels.`,
          },
        ],
        "queue",
      );
    }),
  );
  const deadline = Date.now() + 240000;
  while (!jobs.every((j) => j.done()) && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 100));
  const receipts = [];
  for (const job of jobs) {
    const messages = job.trace
      .filter((e) => e.t === "message.done")
      .map((e) => e.text)
      .join("\n");
    const pixelsMatched = messages.includes(job.expected);
    const storage = await browserCommand(job.b, ["localstorage-get", "owner"]);
    if (!pixelsMatched || !storage.includes(`task-${job.index}`))
      throw Error("shared_process_isolation_or_pixels_failed");
    receipts.push({
      index: job.index,
      session: job.b.session,
      nativeId: job.native.nativeId,
      url: job.b.url,
      pixelsMatched,
      stateMatched: true,
    });
  }
  const receipt = { passed: true, sharedAdapter: true, distinctNativeThreads: true, receipts };
  writeFileSync(path.join(root, "receipt.json"), JSON.stringify(receipt, null, 2));
  writeFileSync(".cache/browser-shared-last.json", JSON.stringify({ root, receipt }, null, 2));
  console.log(JSON.stringify(receipt));
} finally {
  for (const job of jobs) {
    await job.native.close();
    await job.reading;
    await browserCommand(job.b, ["close"]).catch(() => {});
  }
  await hosts.close();
  await mcp.close();
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}
