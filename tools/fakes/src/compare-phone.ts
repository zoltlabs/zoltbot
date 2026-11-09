/** Isolated native phone acceptance fixture. It never uses the person's real link or providers. */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { startFakeRelay } from "../../../packages/daemon/src/relay-test-fixture.js";
import { compareFixture } from "./compare-fixture.js";

const output = path.resolve(process.argv[2] ?? "output/compare/phone");
mkdirSync(output, { recursive: true });
writeFileSync(path.join(output, "fixture-pid.txt"), String(process.pid));
const vault = new Map<string, unknown>();
const relay = await startFakeRelay();
const f = await compareFixture({
  secrets: {
    async put(value) {
      const reference = `keychain:zoltbot:${randomUUID()}`;
      vault.set(reference, value);
      return { reference };
    },
    async read(reference) {
      return vault.get(reference);
    },
  },
});
const socket = new WebSocket(f.daemon.url);
await new Promise<void>((resolve, reject) => {
  socket.addEventListener("open", () => resolve(), { once: true });
  socket.addEventListener("error", reject, { once: true });
});
let next = 0;
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
socket.addEventListener("message", ({ data }) => {
  const message = JSON.parse(data.toString()),
    waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.error) waiter.reject(new Error(message.error.message));
  else waiter.resolve(message.result);
});
function call(method: string, params: unknown = {}, commandId = randomUUID()) {
  const id = ++next;
  return new Promise<unknown>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params, commandId }));
  });
}
await call("hello", { protocolVersion: 1, token: f.daemon.token });
await call("settings.set", { key: "link.relayUrl", value: relay.url });
await call("compare.create", {
  value: { id: "phone-compare", title: "Compare phone acceptance", ceiling: "read_only" },
  members: [
    { threadId: "phone-first", profileId: "profile" },
    { threadId: "phone-second", profileId: "second" },
  ],
  input: [{ type: "text", text: "Plan a small project" }],
});
const relayDeadline = Date.now() + 10000;
while (!relay.macOnline()) {
  if (Date.now() > relayDeadline) throw new Error("synthetic_relay_start_timeout");
  await new Promise((resolve) => setTimeout(resolve, 25));
}
let pairing = (await call("device.pair.start")) as { url: string; expiresAt: string };
writeFileSync(path.join(output, "pairing-url.txt"), pairing.url, { mode: 0o600 });
let working = false;
const timer = setInterval(async () => {
  if (working) return;
  working = true;
  try {
    const devices = (await call("device.list")) as { id: string; state: string }[];
    if (
      !devices.some((d) => d.state === "paired") &&
      Date.parse(pairing.expiresAt) - Date.now() < 60000
    ) {
      pairing = (await call("device.pair.start")) as { url: string; expiresAt: string };
      writeFileSync(path.join(output, "pairing-url.txt"), pairing.url, { mode: 0o600 });
    }
    for (const device of devices.filter((d) => d.state === "pending"))
      await call("device.pair.confirm", { id: device.id, allow: true, confirmed: true });
    writeFileSync(
      path.join(output, "state.json"),
      JSON.stringify({
        entities: f.daemon.store.snapshot(),
        permissions: f.permissions,
        received: [...f.natives].map(([threadId, n]) => ({ threadId, input: n.received })),
      }),
    );
  } finally {
    working = false;
  }
}, 250);
console.log("Synthetic Compare phone fixture ready; pairing URL saved privately.");
async function close() {
  clearInterval(timer);
  socket.close();
  await f.close();
  await relay.close();
  process.exit(0);
}
process.on("SIGTERM", () => {
  void close();
});
process.on("SIGINT", () => {
  void close();
});
