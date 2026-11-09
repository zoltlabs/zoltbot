import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

export interface OpenRouterAuthHost {
  open(url: string): Promise<void>;
  saveKey(key: string): Promise<void>;
}
export interface OpenRouterLogin {
  authorizationUrl: string;
  completion: Promise<void>;
  cancel(): Promise<void>;
}
export async function startOpenRouterLogin(
  host: OpenRouterAuthHost,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<OpenRouterLogin> {
  let verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(32).toString("base64url");
  const callbackPath = `/oauth/openrouter/${randomBytes(16).toString("hex")}`;
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  let resolve = () => {};
  let reject = (_error: Error) => {};
  const completion = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void completion.catch(() => {});
  let done = false,
    exchanging = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let saving = false;
  let authority = "";
  const abort = new AbortController();
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Security-Policy", "default-src 'none'");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    const respond = (status: number, text: string) => {
      response.statusCode = status;
      response.end(text);
    };
    if (
      request.method !== "GET" ||
      request.headers.host !== authority ||
      (request.url?.length && request.url.length > 8192)
    ) {
      respond(400, "Invalid callback.");
      return;
    }
    const url = new URL(request.url ?? "/", `http://${authority}`);
    if (url.pathname !== callbackPath) {
      respond(404, "Not found.");
      return;
    }
    if (done || exchanging) {
      respond(409, "Sign in already completed.");
      return;
    }
    if (url.searchParams.has("error") && !url.searchParams.has("code")) {
      respond(200, "Sign in cancelled. You can close this window.");
      finish(new Error("authorization_declined"));
      return;
    }
    const received = url.searchParams.getAll("state"),
      code = url.searchParams.getAll("code");
    const receivedState = Buffer.from(received[0] ?? ""),
      expectedState = Buffer.from(state);
    if (
      received.length !== 1 ||
      receivedState.length !== expectedState.length ||
      !timingSafeEqual(receivedState, expectedState) ||
      code.length !== 1 ||
      !code[0] ||
      code[0].length > 4096
    ) {
      respond(400, "Invalid callback.");
      return;
    }
    exchanging = true;
    void (async () => {
      try {
        const result = await (options.fetch ?? fetch)("https://openrouter.ai/api/v1/auth/keys", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          redirect: "error",
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]),
          body: JSON.stringify({
            code: code[0],
            code_verifier: verifier,
            code_challenge_method: "S256",
          }),
        });
        if (!result.ok) throw new Error("code_exchange_failed");
        const reader = result.body?.getReader();
        if (!reader) throw new Error("code_exchange_failed");
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.byteLength;
            if (size > 16384) throw new Error("code_exchange_failed");
            chunks.push(part.value);
          }
        } finally {
          await reader.cancel();
        }
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const key = value && typeof value === "object" && "key" in value ? value.key : undefined;
        if (typeof key !== "string" || !key || key.length > 4096 || /[\r\n\0]/.test(key))
          throw new Error("code_exchange_failed");
        if (done || abort.signal.aborted) throw new Error("login_cancelled");
        saving = true;
        clearTimeout(timer);
        await host.saveKey(key);
        respond(200, "OpenRouter connected. You can close this window.");
        finish();
      } catch {
        respond(502, "Could not finish sign in. Return to Zoltbot and try again.");
        finish(new Error("code_exchange_failed"));
      }
    })();
  });
  const close = () => {
    server.closeIdleConnections();
    server.close();
  };
  const finish = (error?: Error) => {
    if (done) return;
    done = true;
    verifier = "";
    clearTimeout(timer);
    abort.abort();
    close();
    if (error) reject(error);
    else resolve();
  };
  try {
    await new Promise<void>((yes, no) => {
      server.once("error", no);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", no);
        yes();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("callback_unavailable");
    authority = `127.0.0.1:${address.port}`;
    const authorize = new URL("https://openrouter.ai/auth");
    authorize.searchParams.set("callback_url", `http://${authority}${callbackPath}`);
    authorize.searchParams.set("code_challenge", challenge);
    authorize.searchParams.set("code_challenge_method", "S256");
    authorize.searchParams.set("state", state);
    authorize.searchParams.set("key_label", "Zoltbot");
    timer = setTimeout(() => finish(new Error("login_timeout")), options.timeoutMs ?? 300000);
    await host.open(authorize.toString());
    return {
      authorizationUrl: authorize.toString(),
      completion,
      async cancel() {
        if (saving) {
          await completion.catch(() => {});
          return;
        }
        finish(new Error("login_cancelled"));
        server.closeAllConnections();
      },
    };
  } catch {
    finish(new Error("callback_unavailable"));
    throw new Error("callback_unavailable");
  }
}
