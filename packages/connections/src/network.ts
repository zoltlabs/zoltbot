import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";

function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0)) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  // Permit only global unicast IPv6, excluding mapped IPv4 and reserved local ranges.
  return /^[23][0-9a-f]{3}:/i.test(address) && !address.toLowerCase().startsWith("2001:db8:");
}
export interface DestinationPolicy {
  origins: readonly string[];
  localOrigins?: readonly string[];
}
export async function checkedDestination(input: string, policy: DestinationPolicy) {
  const url = new URL(input);
  const local = policy.localOrigins?.includes(url.origin) === true;
  if (
    !policy.origins.includes(url.origin) ||
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== "https:" && !(local && url.protocol === "http:"))
  )
    throw new Error("connection_destination_denied");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await lookup(hostname, { all: true });
  if (!addresses.length || (!local && addresses.some((a) => !publicAddress(a.address))))
    throw new Error("connection_destination_denied");
  return { url, address: addresses[0] as { address: string; family: number } };
}
/** DNS is checked then pinned in the actual socket. Redirects are never followed. */
export async function requestJson(
  input: string,
  policy: DestinationPolicy,
  body?: URLSearchParams,
  options: {
    signal?: AbortSignal;
    headers?: Record<string, string>;
    json?: unknown;
    created?: boolean;
    maxBytes?: number;
    responseText?: boolean;
    mcpResponseId?: string;
  } = {},
): Promise<Record<string, unknown>> {
  const { url, address } = await checkedDestination(input, policy);
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? https : http).request(
      url,
      {
        method: body || options.json ? "POST" : "GET",
        ...(options.signal ? { signal: options.signal } : {}),
        headers: {
          ...(body
            ? { "content-type": "application/x-www-form-urlencoded" }
            : { accept: "application/json" }),
          ...(options.json ? { "content-type": "application/json" } : {}),
          ...options.headers,
        },
        lookup: (_host, lookupOptions, callback) => {
          if (lookupOptions.all) callback(null, [address]);
          else callback(null, address.address, address.family);
        },
        timeout: 15000,
      },
      (response) => {
        if (response.statusCode !== 200 && !(options.created && response.statusCode === 201)) {
          response.resume();
          reject(new Error("connection_request_failed"));
          return;
        }
        let text = "";
        let receivedBytes = 0;
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          text += chunk;
          receivedBytes += Buffer.byteLength(chunk);
          if (receivedBytes > (options.maxBytes ?? 65536)) {
            request.destroy(new Error("connection_response_too_large"));
            return;
          }
          if (
            options.mcpResponseId &&
            response.headers["content-type"]?.includes("text/event-stream")
          ) {
            const frames = text.split(/\r?\n\r?\n/);
            text = frames.pop() ?? "";
            for (const frame of frames) {
              const data = frame
                .split(/\r?\n/)
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).trimStart())
                .join("\n");
              try {
                const value = JSON.parse(data);
                if (
                  value &&
                  typeof value === "object" &&
                  !Array.isArray(value) &&
                  value.id === options.mcpResponseId
                ) {
                  resolve(value);
                  response.destroy();
                  return;
                }
              } catch {
                /* Other SSE frames do not establish protocol health. */
              }
            }
          }
        });
        response.on("end", () => {
          try {
            const value: unknown = options.responseText ? { text } : JSON.parse(text);
            if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
            resolve(value as Record<string, unknown>);
          } catch {
            reject(new Error("connection_response_invalid"));
          }
        });
        response.on("error", () => reject(new Error("connection_request_failed")));
      },
    );
    const deadline = setTimeout(
      () => request.destroy(new Error("connection_request_timeout")),
      15000,
    );
    deadline.unref();
    request.on("close", () => clearTimeout(deadline));
    request.on("timeout", () => request.destroy());
    request.on("error", () => reject(new Error("connection_request_failed")));
    request.end(options.json ? JSON.stringify(options.json) : body?.toString());
  });
}
