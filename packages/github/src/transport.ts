import { spawn } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { resolveExecutable } from "../../detect/src/sandbox.js";

export type GitHubTransport = (
  endpoint: string,
  method?: string,
  body?: unknown,
  signal?: AbortSignal,
) => Promise<unknown>;
/** No shell, interactive login, token extraction, inherited host, or raw stderr in errors. */
export const ghTransport: GitHubTransport = async (endpoint, method = "GET", body, signal) => {
  if (signal?.aborted) throw new Error("github_request_cancelled");
  if (
    !(
      endpoint === "graphql" ||
      endpoint === "/user/teams?per_page=100" ||
      /^\/(?:user|repos\/[A-Za-z0-9_%./-]+)(?:\?[A-Za-z0-9_%:=&.-]+)?$/.test(endpoint)
    )
  )
    throw new Error("github_endpoint_invalid");
  const executable = await resolveExecutable("gh", [
    ...(process.env.PATH ?? "").split(path.delimiter),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    path.join(homedir(), ".local/bin"),
  ]);
  if (!executable) throw new Error("github_cli_unavailable");
  if (signal?.aborted) throw new Error("github_request_cancelled");
  return new Promise((resolve, reject) => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          ![
            "GH_HOST",
            "GH_REPO",
            "GH_DEBUG",
            "DEBUG",
            "GH_FORCE_TTY",
            "GH_BROWSER",
            "BROWSER",
          ].includes(key),
      ),
    );
    const child = spawn(
      executable,
      [
        "api",
        "--hostname",
        "github.com",
        ...(endpoint.endsWith("/logs") ? [] : ["--include"]),
        "--method",
        method,
        ...(body === undefined ? [] : ["--input", "-"]),
        endpoint,
      ],
      {
        env: { ...env, GH_PROMPT_DISABLED: "1", GH_PAGER: "cat", NO_COLOR: "1" },
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      },
    );
    const chunks: Buffer[] = [];
    let bytes = 0,
      stderr = "",
      stopped = false;
    const stop = () => {
      stopped = true;
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {}
    };
    const timer = setTimeout(stop, 30000);
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) stop();
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString();
    });
    child.stdin.on("error", () => {});
    child.on("error", () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      reject(new Error("github_cli_unavailable"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      if (stopped)
        return reject(
          new Error(signal?.aborted ? "github_request_cancelled" : "github_request_limit"),
        );
      const output = Buffer.concat(chunks).toString();
      const boundary = output.search(/\r?\n\r?\n/);
      const hasHeaders = output.startsWith("HTTP/") && boundary >= 0;
      const headers = hasHeaders ? output.slice(0, boundary) : "";
      const payload = hasHeaders ? output.slice(boundary).replace(/^\r?\n\r?\n/, "") : output;
      if (code !== 0) {
        const category = /429|rate limit/i.test(stderr)
          ? "rate_limited"
          : /401|auth login|not logged/i.test(stderr)
            ? "auth_required"
            : /403|404|Resource not accessible/i.test(stderr)
              ? "access_denied"
              : /400|405|409|422/.test(stderr)
                ? "write_refused"
                : "request_failed";
        const error = new Error(`github_${category}`) as Error & { retryAfterMs?: number };
        const retry = headers.match(/^retry-after:\s*(.+)$/im)?.[1]?.trim();
        if (retry) {
          const milliseconds = /^\d+$/.test(retry)
            ? Number(retry) * 1000
            : Date.parse(retry) - Date.now();
          if (Number.isFinite(milliseconds))
            error.retryAfterMs = Math.max(0, Math.min(86400000, milliseconds));
        }
        return reject(error);
      }
      try {
        if (/\/actions\/jobs\/[0-9]+\/logs$/.test(endpoint)) {
          resolve(output);
          return;
        }
        const value = JSON.parse(payload);
        if (value.errors) throw new Error("graphql_error");
        resolve(value);
      } catch {
        reject(new Error("github_response_invalid"));
      }
    });
    child.stdin.end(body === undefined ? undefined : JSON.stringify(body));
  });
};
