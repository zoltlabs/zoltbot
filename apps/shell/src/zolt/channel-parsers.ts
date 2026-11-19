import {
  CHANNEL_REQUEST_ACTIONS,
  type ChannelRequestActionName,
  type ChannelRequestInput,
  type PostChannelInput,
} from "../shared/channels";
import { isObject, requireString } from "./parsers";

/** Matches the daemon's limit on a channel post. */
export const CHANNEL_POST_LIMIT = 4000;

export function parsePostChannel(value: unknown): PostChannelInput {
  if (!isObject(value)) throw new Error("Invalid channel post.");
  const text = typeof value.text === "string" ? value.text.trim() : "";
  if (!text) throw new Error("Write a message first.");
  if (text.length > CHANNEL_POST_LIMIT) throw new Error("Keep the message under 4,000 characters.");
  const mentions = Array.isArray(value.mentions)
    ? value.mentions.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
  if (mentions.length > 32) throw new Error("Mention up to 32 members.");
  return {
    channelId: requireString(value.channelId, "channelId"),
    postId: requireString(value.postId, "postId"),
    text,
    ...(mentions.length ? { mentions: [...new Set(mentions)] } : {}),
  };
}

export function parseChannelRequest(value: unknown): ChannelRequestInput {
  if (!isObject(value)) throw new Error("Invalid request action.");
  if (!CHANNEL_REQUEST_ACTIONS.includes(value.action as ChannelRequestActionName))
    throw new Error("action is required.");
  if (!Number.isInteger(value.revision) || Number(value.revision) < 1)
    throw new Error("revision is required.");
  const action = value.action as ChannelRequestActionName;
  return {
    requestId: requireString(value.requestId, "requestId"),
    action,
    revision: Number(value.revision),
    ...(action === "reassign"
      ? { leadThreadId: requireString(value.leadThreadId, "leadThreadId") }
      : {}),
  };
}
