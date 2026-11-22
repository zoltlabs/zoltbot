import { execFile } from "node:child_process";
import { openAsBlob } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { collect, type SandboxRef } from "../src/index.js";
import { shellJoin } from "../src/stream.js";
import {
  BOAT_TEMPLATE,
  boatRequest,
  createBoatApi,
  createBoatTarget,
  saveBoatSnapshot,
} from "../src/targets/boat/index.js";

const git = promisify(execFile);
const apiKey = process.env.BOAT_API_KEY;
const revision = process.argv[2];
if (!apiKey || !revision || !/^[0-9a-f]{40}$/.test(revision)) {
  process.stderr.write("Set BOAT_API_KEY and supply the approved, published public commit SHA.\n");
  process.exit(2);
}
const api = createBoatApi(apiKey);
const target = createBoatTarget({ apiKey, template: null, ttlSeconds: 7200 });
const work = await mkdtemp(join(tmpdir(), "zoltbot-boat-build-"));
let ref: SandboxRef | undefined;
try {
  await git("git", ["merge-base", "--is-ancestor", revision, "refs/remotes/origin/main"]);
  const archive = join(work, "source.tar.gz");
  await git("git", ["archive", "--format=tar.gz", "--output", archive, revision]);
  ref = await target.create({ size: { cpus: 8, memoryMiB: 16384 } });
  const sandboxId = ref.id;
  const upload = await boatRequest(() => api.createUploadUrl({ sandboxId, path: "source.tar.gz" }));
  await boatRequest(async () => {
    const response = await fetch(upload.url, {
      method: upload.method,
      body: await openAsBlob(archive),
      redirect: "error",
      signal: AbortSignal.timeout(600_000),
    });
    if (!response.ok) throw new Error("Upload failed");
  });

  async function run(command: string, message: string) {
    if (!ref) throw new Error("Boat template sandbox is missing");
    const result = await collect(await target.exec(ref, ["sh", "-c", command]));
    if (result.code !== 0) throw new Error(message);
  }
  await run(
    "sudo -n install -d /opt/zoltbot && sudo -n tar -xzf source.tar.gz -C /opt/zoltbot && rm source.tar.gz",
    "Could not unpack the public source archive",
  );
  await run(
    [
      "sudo -n sh /opt/zoltbot/templates/sandbox/install.sh all",
      "install -d -m 700 ~/.boat",
      "install -m 700 /opt/zoltbot/templates/sandbox/boat-pre-stop.sh ~/.boat/pre-stop",
    ].join(" && "),
    "Shared sandbox install or Boat stop hook failed",
  );
  const verify = shellJoin(["sh", "/opt/zoltbot/templates/sandbox/verify.sh"]);
  await run(verify, "Boat base template runtime checks failed");
  await target.sleep(ref);
  await saveBoatSnapshot(api, sandboxId, BOAT_TEMPLATE);

  const clone = await target.create({ template: BOAT_TEMPLATE });
  try {
    const result = await collect(
      await target.exec(clone, ["sh", "/opt/zoltbot/templates/sandbox/verify.sh"]),
    );
    if (result.code !== 0) throw new Error("Saved Boat template runtime checks failed");
  } finally {
    await target.destroy(clone);
  }
  process.stdout.write(`Saved and verified Boat snapshot ${BOAT_TEMPLATE} from ${revision}.\n`);
} catch (error) {
  // Surface fixed build diagnostics without dumping provider responses or command output.
  const message = error instanceof Error ? error.message : "Boat template build failed";
  const publicMessages = [
    "Could not unpack the public source archive",
    "Shared sandbox install or Boat stop hook failed",
    "Boat base template runtime checks failed",
    "Saved Boat template runtime checks failed",
  ];
  process.stderr.write(
    `${publicMessages.includes(message) ? message : "Boat template build failed"}.\n`,
  );
  process.exitCode = 1;
} finally {
  if (ref)
    await target.destroy(ref).catch(() => {
      process.stderr.write("Boat build sandbox cleanup failed.\n");
      process.exitCode = 1;
    });
  await rm(work, { recursive: true, force: true });
}
