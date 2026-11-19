import { For, Show } from "solid-js";
import type { ChannelSummary } from "../../../shared/channels";

interface SidebarChannelsProps {
  projectName: string;
  channels: ChannelSummary[];
  activeChannelId: string | null;
  onOpenChannel: (channelId: string) => void;
}

/** A project's channels, one `#name` row each, under the project's heading in the sidebar. */
export function SidebarChannels(props: SidebarChannelsProps) {
  return (
    <Show when={props.channels.length > 0}>
      <ul class="sidebar-channels" aria-label={`${props.projectName} channels`}>
        <For each={props.channels}>
          {(channel) => (
            <li>
              <button
                type="button"
                class="sidebar-channel-row"
                classList={{ "sidebar-channel-row-active": props.activeChannelId === channel.id }}
                aria-current={props.activeChannelId === channel.id ? "page" : undefined}
                onClick={() => props.onOpenChannel(channel.id)}
              >
                <span class="sidebar-channel-hash" aria-hidden="true">
                  #
                </span>
                <span class="sidebar-channel-name">{channel.name}</span>
                <Show when={channel.activeRequests > 0}>
                  <span class="sidebar-channel-count">
                    {channel.activeRequests}
                    <span class="sr-only">
                      {channel.activeRequests === 1 ? " open request" : " open requests"}
                    </span>
                  </span>
                </Show>
              </button>
            </li>
          )}
        </For>
      </ul>
    </Show>
  );
}
