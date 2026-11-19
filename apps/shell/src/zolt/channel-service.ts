import type {
  ChannelDetail,
  ChannelRequestInput,
  ChannelSummary,
  PostChannelInput,
} from "../shared/channels";
import { type ChannelReadResult, toChannelDetail, toChannelSummaries } from "./channels-view";
import type { DaemonClient } from "./daemon-client";

/** Rows that change what a channel shows; main tells the renderer when one changes. */
export const CHANNEL_ROWS = ["channel", "channelPost", "channelRequest"] as const;

/** The shell's side of team channels: lists come from the snapshot, the rest from the daemon. */
export function channelService(client: DaemonClient) {
  async function read(channelId: string): Promise<ChannelDetail> {
    const result = (await client.call("channel.read", { id: channelId })) as ChannelReadResult;
    return toChannelDetail(client.snapshot, result);
  }
  return {
    list(): ChannelSummary[] {
      return toChannelSummaries(client.snapshot);
    },
    read,
    async post(input: PostChannelInput): Promise<void> {
      await client.call(
        "channel.post",
        {
          channelId: input.channelId,
          id: input.postId,
          text: input.text,
          ...(input.mentions?.length ? { mentions: input.mentions } : {}),
        },
        `shell:channel-post:${input.postId}`,
      );
    },
    /** Clicking Stop in the confirmation is the person's confirmation. */
    async request(input: ChannelRequestInput): Promise<void> {
      await client.call(
        "channel.request",
        {
          id: input.requestId,
          action: input.action,
          revision: input.revision,
          ...(input.leadThreadId ? { leadThreadId: input.leadThreadId } : {}),
          confirmed: true,
        },
        `shell:channel-request:${input.requestId}:${input.revision}:${input.action}`,
      );
    },
  };
}
