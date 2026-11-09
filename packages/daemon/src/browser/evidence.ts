import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { inflateSync } from "node:zlib";
import type { ToolActor } from "@zoltbot/hostmcp";
import { compareSessions } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import type { BrowserBinding } from "./runtime.js";
import { redactBrowserText } from "./runtime.js";
export interface BrowserEvidence {
  id: string;
  taskId: string;
  executionId: string;
  sessionId: string;
  generation: number;
  revision: number;
  url: string;
  viewport: { width: number; height: number };
  capturedAt: string;
  hash: string;
  bytes: number;
  mime: "image/png";
  canonicalPath: string;
  inspection: "not_reported" | "agent_reported";
  check: string;
  outcome: "passed" | "failed" | "partial";
  source: "agent_reported";
}
export function frozenBrowser(store: Store, taskId: string, sessionId?: string) {
  const task = store.record("task", taskId);
  if (!task) throw Error("task_not_found");
  const session = store
    .snapshot(["session"])
    .session?.filter((s) => s.threadId === task.threadId && (!sessionId || s.id === sessionId))
    .sort(compareSessions)[0];
  const config = session
    ? (store
        .snapshot(["settings"])
        .settings?.find((r) => r.key === `runtime.configuration.${session.id}`)?.value as
        | { launchManifest?: { executionId: string; browser?: BrowserBinding } }
        | undefined)
    : undefined;
  const manifest = config?.launchManifest;
  if (!manifest?.browser) throw Error("browser_not_enabled_at_launch");
  return {
    task,
    sessionId: String(session?.id),
    executionId: manifest.executionId,
    binding: manifest.browser,
  };
}
export function ownedBrowser(store: Store, actor: ToolActor) {
  const thread = store.record("thread", actor.threadId);
  if (thread?.agentId !== actor.agentId || typeof thread.taskId !== "string")
    throw Error("browser_authority_denied");
  return frozenBrowser(store, thread.taskId, actor.sessionId);
}
export function browserGeneration(store: Store, id: string, binding?: BrowserBinding) {
  const row = store.database
    .prepare("SELECT generation,nonce FROM browser_lifecycle WHERE binding_id=?")
    .get(id) as { generation: number; nonce?: string } | undefined;
  let nonce: string | undefined;
  if (binding)
    try {
      const receipt = JSON.parse(readFileSync(path.join(binding.home, "generation.json"), "utf8"));
      if (typeof receipt.nonce === "string" && /^[0-9a-f-]{36}$/.test(receipt.nonce))
        nonce = receipt.nonce;
    } catch {}
  const generation = (row?.generation ?? 0) + (nonce && nonce !== row?.nonce ? 1 : 0);
  if (nonce && nonce !== row?.nonce)
    store.database
      .prepare(
        "INSERT INTO browser_lifecycle(binding_id,generation,nonce,state,mode,updated_at) VALUES(?,?,?,'unknown',?,?) ON CONFLICT(binding_id) DO UPDATE SET generation=excluded.generation,nonce=excluded.nonce",
      )
      .run(id, generation, nonce, binding?.mode ?? "background", new Date().toISOString());
  return generation || 1;
}
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const limit = 8 * 1024 * 1024;
function regularRead(root: string, relative: string) {
  if (
    !relative ||
    path.isAbsolute(relative) ||
    relative.split(/[\\/]/).some((p) => p === ".." || p === "." || !p)
  )
    throw Error("invalid_evidence_path");
  const canonical = realpathSync(root);
  if (canonical !== path.resolve(root)) throw Error("evidence_root_symlink_denied");
  let file = canonical;
  for (const part of relative.split("/")) {
    file = path.join(file, part);
    if (lstatSync(file).isSymbolicLink()) throw Error("evidence_symlink_denied");
  }
  if (!realpathSync(file).startsWith(`${canonical}${path.sep}`))
    throw Error("evidence_outside_root");
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit || stat.size < 45)
      throw Error("invalid_evidence_file");
    const bytes = readFileSync(fd);
    if (bytes.length !== stat.size) throw Error("evidence_changed");
    return bytes;
  } finally {
    closeSync(fd);
  }
}
export function validatePng(bytes: Buffer) {
  if (
    bytes.length > limit ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    throw Error("evidence_mime_mismatch");
  let offset = 8;
  let width = 0,
    height = 0;
  const chunks: Buffer[] = [];
  let end = false;
  while (offset + 12 <= bytes.length) {
    const n = bytes.readUInt32BE(offset);
    if (n > limit || offset + n + 12 > bytes.length) throw Error("invalid_png");
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + n);
    let crc = 0xffffffff;
    for (const value of bytes.subarray(offset + 4, offset + 8 + n)) {
      crc ^= value;
      for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    if ((crc ^ 0xffffffff) >>> 0 !== bytes.readUInt32BE(offset + 8 + n))
      throw Error("invalid_png_crc");
    if (offset === 8) {
      if (type !== "IHDR" || n !== 13) throw Error("invalid_png");
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (
        !width ||
        !height ||
        width * height > 20000000 ||
        data[8] !== 8 ||
        ![2, 6].includes(data[9] ?? 0) ||
        data[12] !== 0
      )
        throw Error("unsupported_png");
    }
    if (type === "IDAT") chunks.push(data);
    offset += 12 + n;
    if (type === "IEND") {
      end = true;
      break;
    }
  }
  if (!end || offset !== bytes.length || !chunks.length) throw Error("invalid_png");
  const color = bytes[25] === 6 ? 4 : 3;
  const decoded = inflateSync(Buffer.concat(chunks), {
    maxOutputLength: Math.min(100000000, (width * color + 1) * height),
  });
  if (decoded.length !== (width * color + 1) * height) throw Error("invalid_png_pixels");
  return { width, height };
}
export function registerEvidence(
  store: Store,
  actor: ToolActor,
  args: {
    path: string;
    url: string;
    viewport: { width: number; height: number };
    check: string;
    outcome: "passed" | "failed" | "partial";
    inspection?: "agent_reported";
  },
) {
  const owner = ownedBrowser(store, actor);
  const bytes = regularRead(owner.binding.artifactRoot, args.path);
  validatePng(bytes);
  const digest = hash(bytes);
  const generation = browserGeneration(store, owner.binding.id, owner.binding);
  const id = hash(
    Buffer.from(JSON.stringify([owner.executionId, owner.task.revision, generation, digest])),
  );
  const existing = store.database
    .prepare("SELECT metadata FROM browser_evidence WHERE id=?")
    .get(id) as { metadata: string } | undefined;
  if (existing) {
    evidenceBytes(store, id);
    const value = JSON.parse(existing.metadata) as BrowserEvidence;
    if (
      value.check !== args.check ||
      value.outcome !== args.outcome ||
      value.url !== redactBrowserText(args.url) ||
      JSON.stringify(value.viewport) !== JSON.stringify(args.viewport)
    )
      throw Error("evidence_claim_conflict");
    if (args.inspection === "agent_reported") {
      value.inspection = "agent_reported";
      store.database
        .prepare("UPDATE browser_evidence SET metadata=? WHERE id=?")
        .run(JSON.stringify(value), id);
    }
    return value;
  }
  const directory = path.join(owner.binding.artifactRoot, "evidence");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink()) throw Error("evidence_symlink_denied");
  const canonicalPath = path.join(directory, `${digest}.png`);
  try {
    const temporary = path.join(directory, `${digest}.${randomUUID()}.partial`);
    try {
      writeFileSync(temporary, bytes, { flag: "wx", mode: 0o400 });
      linkSync(temporary, canonicalPath);
    } finally {
      try {
        unlinkSync(temporary);
      } catch {}
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if (hash(regularRead(owner.binding.artifactRoot, `evidence/${digest}.png`)) !== digest)
    throw Error("evidence_hash_mismatch");
  const value: BrowserEvidence = {
    id,
    taskId: String(owner.task.id),
    executionId: owner.executionId,
    sessionId: actor.sessionId,
    generation,
    revision: Number(owner.task.revision),
    url: redactBrowserText(args.url),
    viewport: args.viewport,
    capturedAt: new Date().toISOString(),
    hash: digest,
    bytes: bytes.length,
    mime: "image/png",
    canonicalPath,
    inspection: args.inspection ?? "not_reported",
    check: args.check,
    outcome: args.outcome,
    source: "agent_reported",
  };
  store.database
    .prepare("INSERT INTO browser_evidence(id,task_id,metadata) VALUES(?,?,?)")
    .run(id, value.taskId, JSON.stringify(value));
  return value;
}
export function evidenceBytes(store: Store, id: string) {
  const row = store.database.prepare("SELECT metadata FROM browser_evidence WHERE id=?").get(id) as
    | { metadata: string }
    | undefined;
  if (!row) throw Error("evidence_not_found");
  const value = JSON.parse(row.metadata) as BrowserEvidence;
  const owner = frozenBrowser(store, value.taskId, value.sessionId);
  const bytes = regularRead(owner.binding.artifactRoot, `evidence/${value.hash}.png`);
  validatePng(bytes);
  if (hash(bytes) !== value.hash) throw Error("evidence_hash_mismatch");
  return bytes;
}
