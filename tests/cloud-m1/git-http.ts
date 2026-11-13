import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

/** Smart HTTP for one disposable bare repository. No filesystem path comes from the caller. */
export async function startFixtureGit(remote: string) {
  const children = new Set<ReturnType<typeof spawn>>();
  const server = createServer((incoming, outgoing) => {
    const url = new URL(incoming.url ?? "/", "http://127.0.0.1");
    const valid =
      (incoming.method === "GET" &&
        url.pathname === "/fixture.git/info/refs" &&
        ["?service=git-upload-pack", "?service=git-receive-pack"].includes(url.search)) ||
      (incoming.method === "POST" &&
        ["/fixture.git/git-upload-pack", "/fixture.git/git-receive-pack"].includes(url.pathname) &&
        !url.search);
    if (!valid) {
      outgoing.writeHead(404).end();
      incoming.resume();
      return;
    }
    const child = spawn("git", ["http-backend"], {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_HTTP_EXPORT_ALL: "1",
        GIT_PROJECT_ROOT: path.dirname(remote),
        PATH_INFO: `/${path.basename(remote)}${url.pathname.slice("/fixture.git".length)}`,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: incoming.method ?? "GET",
        CONTENT_TYPE: incoming.headers["content-type"] ?? "",
        REMOTE_ADDR: "127.0.0.1",
      },
      stdio: ["pipe", "pipe", "ignore"],
    });
    children.add(child);
    const chunks: Buffer[] = [];
    let inputBytes = 0,
      outputBytes = 0;
    const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
    incoming.on("data", (chunk: Buffer) => {
      inputBytes += chunk.length;
      if (inputBytes > 16 * 1024 * 1024) child.kill("SIGKILL");
    });
    incoming.once("aborted", () => child.kill("SIGKILL"));
    child.stdin.on("error", () => {});
    incoming.pipe(child.stdin);
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > 32 * 1024 * 1024) child.kill("SIGKILL");
      else chunks.push(chunk);
    });
    child.once("error", () => outgoing.writeHead(503).end());
    child.once("close", (code) => {
      clearTimeout(timer);
      children.delete(child);
      if (outgoing.writableEnded) return;
      const bytes = Buffer.concat(chunks),
        split = bytes.indexOf("\r\n\r\n");
      if (code !== 0 || split < 0 || inputBytes > 16 * 1024 * 1024) {
        outgoing.writeHead(503).end();
        return;
      }
      let status = 200;
      const headers: Record<string, string> = {};
      for (const line of bytes.subarray(0, split).toString().split("\r\n")) {
        const colon = line.indexOf(":"),
          name = line.slice(0, colon).toLowerCase();
        const value = line.slice(colon + 1).trim();
        if (name === "status") status = Number(value.slice(0, 3));
        else if (["content-type", "cache-control", "expires", "pragma"].includes(name))
          headers[name] = value;
      }
      outgoing.writeHead(status, headers).end(bytes.subarray(split + 4));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return Object.freeze({
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    async close() {
      for (const child of children) child.kill("SIGKILL");
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  });
}
