import type { Row } from "./transport.js";

export interface PushPermission {
  granted: boolean;
  canAskAgain: boolean;
  status: string;
}
export interface PushApi {
  getPermissionsAsync(): Promise<PushPermission>;
  requestPermissionsAsync(): Promise<PushPermission>;
  getDevicePushTokenAsync(): Promise<{ type: string; data: string | number[] }>;
}
export async function inspectPush(api: PushApi, ask: boolean) {
  let permission = await api.getPermissionsAsync();
  if (ask && !permission.granted && permission.canAskAgain)
    permission = await api.requestPermissionsAsync();
  if (!permission.granted) return { permission, token: undefined };
  try {
    const token = await api.getDevicePushTokenAsync();
    return {
      permission,
      token: token.type === "ios" && typeof token.data === "string" ? token.data : undefined,
    };
  } catch {
    return { permission, token: undefined };
  }
}

// Actionable approval notifications. The Mac sends category "approval" with data keys
// interactionId, version and threadId; anything missing makes the action buttons a no-op.

export const approvalCategory = "approval";
export const pushActions = { allow: "allow_once", reject: "reject" } as const;

export interface PushTarget {
  category: string;
  threadId?: string;
  interactionId?: string;
  version?: number;
}
const field = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;
/** Reads the routing keys from a notification, tolerating a nested `body` and string versions. */
export function readPushTarget(content: {
  categoryIdentifier?: string | null;
  data?: unknown;
}): PushTarget {
  const raw = content.data && typeof content.data === "object" ? (content.data as Row) : {};
  const nested = raw.body && typeof raw.body === "object" ? (raw.body as Row) : {};
  const data = { ...nested, ...raw };
  const version = Number(data.version);
  const target: PushTarget = {
    category: field(content.categoryIdentifier) ?? field(data.category) ?? "",
  };
  const threadId = field(data.threadId);
  const interactionId = field(data.interactionId);
  if (threadId) target.threadId = threadId;
  if (interactionId) target.interactionId = interactionId;
  if (Number.isInteger(version) && version >= 1) target.version = version;
  return target;
}

export type PushResponse =
  | { kind: "open"; threadId: string }
  | {
      kind: "answer";
      id: string;
      version: number;
      threadId?: string;
      answer: { action: "accept" | "decline"; choice: string; feedback?: string };
    }
  | { kind: "none" };
/** What a notification tap or action button should do. */
export function pushResponse(
  target: PushTarget,
  actionIdentifier: string,
  userText?: string,
): PushResponse {
  const quick = actionIdentifier === pushActions.allow || actionIdentifier === pushActions.reject;
  if (!quick)
    return target.threadId ? { kind: "open", threadId: target.threadId } : { kind: "none" };
  if (target.category !== approvalCategory || !target.interactionId || !target.version)
    return { kind: "none" };
  const feedback = userText?.trim();
  return {
    kind: "answer",
    id: target.interactionId,
    version: target.version,
    ...(target.threadId ? { threadId: target.threadId } : {}),
    answer:
      actionIdentifier === pushActions.allow
        ? { action: "accept", choice: "allow_once" }
        : { action: "decline", choice: "reject_once", ...(feedback ? { feedback } : {}) },
  };
}
