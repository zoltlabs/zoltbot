import {
  CellTokenRequestSchema,
  CellTokenResultSchema,
  CloudDeviceKeySchema,
  CloudSecretWriteSchema,
} from "@zoltbot/cloud-contracts";
import { parse } from "@zoltbot/protocol";

/** Native-only routes. Provider values may be written, never returned by this port. */
export function cloudSettingsRequest(
  path: string,
  method: string,
  payload?: string,
):
  | {
      payload?: string;
      response(value: unknown): unknown;
    }
  | undefined {
  const secret = /^\/api\/cloud\/secrets\/(?:anthropic|openai|github)$/.test(path),
    register = path === "/api/cloud/devices" && method === "POST",
    revoke = /^\/api\/cloud\/devices\/[A-Za-z0-9_-]{22}$/.test(path) && method === "DELETE",
    cell = path === "/api/cloud/cell-token" && method === "POST";
  if (!((secret && method === "PUT") || register || revoke || cell)) return undefined;
  let frozen: string | undefined;
  try {
    if (revoke) {
      if (payload !== undefined) throw new Error();
    } else {
      if (payload === undefined) throw new Error();
      const input: unknown = JSON.parse(payload);
      const value = secret
        ? parse(CloudSecretWriteSchema, input)
        : register
          ? parse(CloudDeviceKeySchema, input)
          : parse(CellTokenRequestSchema, input);
      frozen = JSON.stringify(value);
    }
  } catch {
    throw new Error("account_request_invalid");
  }
  return {
    ...(frozen === undefined ? {} : { payload: frozen }),
    response(value) {
      try {
        if (cell) return parse(CellTokenResultSchema, value);
        if (
          !value ||
          typeof value !== "object" ||
          Array.isArray(value) ||
          Object.keys(value).join(",") !== "ok" ||
          !("ok" in value) ||
          value.ok !== true
        )
          throw new Error();
        return { ok: true };
      } catch {
        throw new Error("account_service_unavailable");
      }
    },
  };
}
