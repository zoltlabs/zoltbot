import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import type { RequestListener } from "node:http";
import { createServer } from "node:https";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Test TLS key stays in memory and reaches OpenSSL through a private pipe, never a file. */
export async function loopbackTls() {
  const key = Buffer.from(
    generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({
      format: "pem",
      type: "pkcs8",
    }),
  );
  const certificate = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      "openssl",
      [
        "req",
        "-new",
        "-x509",
        "-key",
        "/dev/fd/3",
        "-subj",
        "/CN=127.0.0.1",
        "-addext",
        "subjectAltName=IP:127.0.0.1,DNS:host.docker.internal",
        "-days",
        "1",
        "-sha256",
      ],
      {
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", OPENSSL_CONF: "/dev/null" },
        stdio: ["ignore", "pipe", "pipe", "pipe"],
      },
    );
    const chunks: Buffer[] = [];
    let bytes = 0;
    const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
    child.once("error", () => {
      clearTimeout(timeout);
      reject(new Error("fixture_tls_unavailable"));
    });
    const stdout = child.stdout,
      stderr = child.stderr;
    if (!stdout || !stderr) {
      clearTimeout(timeout);
      child.kill("SIGKILL");
      reject(new Error("fixture_tls_unavailable"));
      return;
    }
    stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 16384) child.kill("SIGKILL");
      else chunks.push(Buffer.from(chunk));
    });
    // Never print OpenSSL diagnostics: failures must not expose key material or configuration.
    stderr.resume();
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error("fixture_tls_unavailable"));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
    const pipe = child.stdio[3];
    if (!pipe || !("end" in pipe)) {
      child.kill("SIGKILL");
      reject(new Error("fixture_tls_unavailable"));
      return;
    }
    pipe.on("error", () => child.kill("SIGKILL"));
    pipe.end(key);
  });
  return Object.freeze({
    certificate: () => certificate,
    server: (listener: RequestListener) => createServer({ key, cert: certificate }, listener),
    childEnvironment: () => ({
      NODE_OPTIONS: `--import=${pathToFileURL(path.resolve("tests/cloud-m1/trust.mjs")).href}`,
      ZOLTBOT_TEST_CA_CERTIFICATE: certificate,
    }),
  });
}
