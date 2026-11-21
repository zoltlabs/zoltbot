// S9: icons for the sidebar's sort menu and a chat's row menu.
import type { JSX } from "solid-js";
import { t } from "../../i18n";
import "./chat-mute.css";

function Icon(props: { children: JSX.Element }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      class="size-4 fill-none stroke-current"
      stroke-width="1.4"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      {props.children}
    </svg>
  );
}

export const SortIcon = () => (
  <Icon>
    <path d="M6 4v12M3.5 13.5 6 16l2.5-2.5M14 16V4M11.5 6.5 14 4l2.5 2.5" />
  </Icon>
);
export const PinIcon = () => (
  <Icon>
    <path d="M7.5 3.5h5M8.5 3.5v4.2L6 10.5h8l-2.5-2.8V3.5M10 10.5V16" />
  </Icon>
);
export const UnreadIcon = () => (
  <Icon>
    <circle cx="10" cy="10" r="3.2" />
    <circle cx="10" cy="10" r="6.5" />
  </Icon>
);
/** A3: a bell with a slash, for Mute and the muted row. */
export const MutedIcon = () => (
  <Icon>
    <path d="M7.2 4.3A4.5 4.5 0 0 1 14.5 8c0 2.4.5 3.9 1 4.8M13.5 14.5H3.5s1.5-1.3 1.5-6.5c0-.6.1-1.1.3-1.6M8.6 16.5a1.6 1.6 0 0 0 2.8 0M3 3l14 14" />
  </Icon>
);
/** A3: shown after a muted chat's name. */
export const MutedMark = () => (
  <span class="bot-row-muted" role="img" aria-label={t("sidebar.chat.muted")}>
    <MutedIcon />
  </span>
);
export const ArchiveIcon = () => (
  <Icon>
    <path d="M3.5 5.5h13v3h-13zM4.5 8.5v7h11v-7M8 11.5h4" />
  </Icon>
);
