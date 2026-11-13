import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

/** Test client with explicit CA trust, bounded bodies and no redirect or external-network path. */
export function loopbackClient(certificate: string) {
  return async (
    url: URL,
    input: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
  ) => {
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.hostname !== "127.0.0.1" ||
      url.username ||
      url.password
    )
      throw new Error("fixture_http_target_invalid");
    const body = input.body === undefined ? undefined : JSON.stringify(input.body);
    return new Promise<Response>((resolve, reject) => {
      const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
        url,
        {
          method: input.method ?? (body === undefined ? "GET" : "POST"),
          headers: {
            ...input.headers,
            ...(body === undefined
              ? {}
              : {
                  "content-type": "application/json",
                  "content-length": String(Buffer.byteLength(body)),
                }),
          },
          ...(url.protocol === "https:" ? { ca: certificate } : {}),
        },
        (response) => {
          const parts: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk) => {
            size += chunk.length;
            if (size > 8 * 1024 * 1024) request.destroy();
            else parts.push(Buffer.from(chunk));
          });
          response.once("error", () => reject(new Error("fixture_http_failed")));
          response.once("end", () =>
            resolve(
              new Response(
                [204, 205, 304].includes(response.statusCode ?? 502) ? null : Buffer.concat(parts),
                {
                  status: response.statusCode ?? 502,
                  headers: Object.fromEntries(
                    Object.entries(response.headers).filter(
                      (entry): entry is [string, string] => typeof entry[1] === "string",
                    ),
                  ),
                },
              ),
            ),
          );
        },
      );
      request.setTimeout(30000, () => request.destroy());
      request.once("error", () => reject(new Error("fixture_http_failed")));
      request.end(body);
    });
  };
}
export async function responseJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const result = await response.json();
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error();
    return result;
  } catch {
    throw new Error("fixture_response_invalid");
  }
}
export function cellClient(input: {
  origin: string;
  token: string;
  orgId: string;
  fetch: ReturnType<typeof loopbackClient>;
}) {
  let sequence = 0;
  return Object.freeze({
    async rpc(method: string, params: unknown, commandId?: string): Promise<unknown> {
      const response = await input.fetch(
        new URL(`/v1/orgs/${encodeURIComponent(input.orgId)}/rpc`, input.origin),
        {
          method: "POST",
          headers: { authorization: `Bearer ${input.token}` },
          body: {
            jsonrpc: "2.0",
            id: ++sequence,
            method,
            params,
            ...(commandId ? { commandId } : {}),
          },
        },
      );
      if (response.status !== 200) throw new Error(`fixture_rpc_http_${response.status}`);
      const body = await responseJson(response),
        error = body.error as { message?: unknown } | undefined;
      if (error) {
        const code =
          typeof error.message === "string" && /^[a-z_]{1,100}$/.test(error.message)
            ? error.message
            : "failed";
        throw new Error(`fixture_rpc_${code}`);
      }
      return body.result;
    },
  });
}
