#!/usr/bin/env node
// D10: pairs a phone or a desktop with a headless daemon, such as one on a Linux server.
// It talks to the daemon on this machine, prints a pairing link, then asks before allowing the
// device that answers it.
//
//   node scripts/zoltbot-pair.mjs [--data-dir <folder>] [--no-wait]
//
// The data folder is the daemon's ZOLTBOT_DATA_DIR (default ~/.local/share/zoltbot/data).
import { randomUUID } from "node:crypto";
import { createReadStream, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const dataDir = path.resolve(
  option("--data-dir") ??
    process.env.ZOLTBOT_DATA_DIR ??
    path.join(homedir(), ".local/share/zoltbot/data"),
);

/** The daemon's local address and token, which only its own user can read. */
function connection() {
  try {
    return JSON.parse(readFileSync(path.join(dataDir, "daemon.json"), "utf8"));
  } catch {
    throw new Error(`Zoltbot isn't running with data in ${dataDir}. Start it, then try again.`);
  }
}

/** A JSON-RPC client over the daemon's local WebSocket. */
async function connect({ url, token }) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let next = 1;
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message ?? "request_failed"));
    else waiter.resolve(message.result);
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("daemon_unreachable")), {
      once: true,
    });
  });
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = next++;
      pending.set(id, { resolve, reject });
      // Every call carries a command id; the daemon requires one for changes such as confirming.
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params, commandId: randomUUID() }));
    });
  await call("hello", { token, protocolVersion: 1 });
  return { call, close: () => socket.close() };
}

/**
 * The terminal to ask on: stdin, or the controlling terminal when stdin is a pipe, as under
 * `curl … | bash`. Null when there's none.
 */
function terminal() {
  if (process.stdin.isTTY) return process.stdin;
  try {
    // Opened now, so a server with no terminal fails here rather than mid-question.
    return createReadStream("", { fd: openSync("/dev/tty", "r") });
  } catch {
    return null;
  }
}

const client = await connect(connection());
try {
  const started = new Date(Date.now() - 1000).toISOString();
  const offer = await client.call("device.pair.start");
  process.stdout.write(
    `Open this link on the device to pair, before ${new Date(offer.expiresAt).toLocaleTimeString()}:\n\n  ${offer.url}\n\n`,
  );
  if (!args.includes("--no-wait")) {
    const deadline = Date.parse(offer.expiresAt);
    let device;
    while (!device && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      // Only a device that answered this link, the newest first.
      device = (await client.call("device.list"))
        .filter((item) => item.state === "pending" && item.createdAt >= started)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    }
    if (!device) throw new Error("No device answered before the link ran out. Run this again.");
    const input = terminal();
    if (!input) throw new Error("Run this in a terminal to confirm the device.");
    const prompt = createInterface({ input, output: process.stdout });
    if (device.confirmCode)
      process.stdout.write(`${device.name} shows ${device.confirmCode}. Check it matches.\n`);
    const answer = (await prompt.question(`Allow ${device.name}? [y/n] `).catch(() => "")).trim();
    prompt.close();
    input.destroy?.();
    // Only a clear answer changes anything; the device stays pending until the link runs out.
    if (!/^(y(es)?|n(o)?)$/i.test(answer)) throw new Error("No answer. Run this again to pair.");
    const allow = /^y/i.test(answer);
    await client.call("device.pair.confirm", { id: device.id, allow, confirmed: true });
    process.stdout.write(allow ? `${device.name} is paired.\n` : "Not paired.\n");
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  client.close();
}
