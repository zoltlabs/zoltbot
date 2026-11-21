// R2: the cloud routes a Mac uses for routine web addresses. Requests and responses are checked
// here, so neither a caller of the account port nor the cloud can widen what passes through.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RESOURCE = /^webhook\/[A-Za-z0-9][A-Za-z0-9_-]{0,191}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const MIME = /^[\w.+-]+\/[\w.+-]+$/;
/** The cloud returns the start of each body, up to this many characters. */
const BODY = 4096;

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown) => typeof value === "string" && UUID.test(value);
const time = (value: unknown) =>
  typeof value === "string" && ISO.test(value) && Number.isFinite(Date.parse(value));

function invalid(): never {
  throw new Error("account_service_unavailable");
}

function hooks(value: unknown) {
  if (!record(value) || !record(value.account) || !id(value.account.id)) invalid();
  if (!Array.isArray(value.hooks) || value.hooks.length > 50) invalid();
  return {
    account: { id: value.account.id as string },
    hooks: value.hooks.map((hook: unknown) => {
      if (!record(hook) || !id(hook.id) || typeof hook.resource !== "string") invalid();
      if (!RESOURCE.test(hook.resource) || !time(hook.createdAt)) invalid();
      return {
        id: hook.id as string,
        resource: hook.resource,
        createdAt: hook.createdAt as string,
      };
    }),
  };
}

function created(value: unknown, resource: string) {
  if (!record(value) || !id(value.id) || value.resource !== resource) invalid();
  if (typeof value.url !== "string" || value.url.length > 2048) invalid();
  try {
    const url = new URL(value.url);
    if (!/^\/h\/[A-Za-z0-9_-]{43}$/.test(url.pathname) || url.search || url.hash) invalid();
  } catch {
    invalid();
  }
  return { id: value.id as string, resource, url: value.url };
}

function requests(value: unknown) {
  if (!record(value) || !Array.isArray(value.requests) || value.requests.length > 50) invalid();
  return {
    requests: value.requests.map((request: unknown) => {
      if (!record(request) || !id(request.id) || !time(request.receivedAt)) invalid();
      if (typeof request.body !== "string" || request.body.length > BODY) invalid();
      const type = request.contentType;
      if (type !== undefined && (typeof type !== "string" || type.length > 100 || !MIME.test(type)))
        invalid();
      return {
        id: request.id as string,
        receivedAt: request.receivedAt as string,
        ...(type === undefined ? {} : { contentType: type as string }),
        body: request.body,
      };
    }),
  };
}

/** Hook routes the account owner may call, or undefined when `path` is none of them. */
export function hookRouteRequest(
  path: string,
  method: string,
  payload?: string,
): { payload?: string; response(value: unknown): unknown } | undefined {
  if (path === "/api/cloud/hooks" && method === "GET") {
    if (payload !== undefined) throw new Error("account_request_invalid");
    return { response: hooks };
  }
  if (path === "/api/cloud/hooks" && method === "POST") {
    let resource: unknown;
    try {
      const input: unknown = JSON.parse(payload ?? "");
      if (!record(input) || Object.keys(input).join(",") !== "resource") throw new Error();
      resource = input.resource;
    } catch {
      throw new Error("account_request_invalid");
    }
    if (typeof resource !== "string" || !RESOURCE.test(resource))
      throw new Error("account_request_invalid");
    return {
      payload: JSON.stringify({ resource }),
      response: (value) => created(value, resource),
    };
  }
  const deleted = /^\/api\/cloud\/hooks\/([0-9a-f-]{36})$/.exec(path);
  if (deleted && method === "DELETE" && id(deleted[1])) {
    if (payload !== undefined) throw new Error("account_request_invalid");
    return {
      response: (value) =>
        record(value) && value.ok === true && Object.keys(value).length === 1
          ? { ok: true }
          : invalid(),
    };
  }
  const listed = /^\/api\/cloud\/hooks\/([0-9a-f-]{36})\/requests\?since=([^&]+)$/.exec(path);
  if (listed && method === "GET" && id(listed[1])) {
    if (payload !== undefined || !time(decodeURIComponent(listed[2] ?? "")))
      throw new Error("account_request_invalid");
    return { response: requests };
  }
  if (path.startsWith("/api/cloud/hooks")) throw new Error("account_request_invalid");
  return undefined;
}
