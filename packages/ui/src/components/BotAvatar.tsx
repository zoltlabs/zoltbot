import type { CSSProperties } from "react";
import { avatarHue, useProfileHue } from "./identity.js";
import "./bot-avatar.css";

// Original silhouettes: each employee keeps the same character across renames and restarts.
const bodies = [
  "M8 7h16v3h4v15h-4v3H8v-3H4V10h4Z",
  "M6 5l7 5h6l7-5v20l-5 3H11l-5-3Z",
  "M12 4h8v4h6v5h3v11h-5v4H8v-4H3V13h3V8h6Z",
  "M11 5h10v3h5v5h3v10h-5v5H8v-5H3V13h3V8h5Z",
  "M5 9h7V5h8v4h7v17H5Z",
  "M10 5h12v4h5v15h-5v4H10v-4H5V9h5Z",
  "M9 3h5v7h4V3h5v7h4v14h-4v4H9v-4H5V10h4Z",
  "M10 4h12v4h4v4h3v13h-5v4h-4v-4h-8v4H8v-4H3V12h3V8h4Z",
];

export function BotAvatar({
  id,
  state = "idle",
  zolt = false,
  size = "sm",
}: {
  id: string;
  state?: string;
  zolt?: boolean;
  size?: "sm" | "md";
}) {
  const hue = useProfileHue(id) ?? avatarHue(id);
  return (
    <span
      className={`bot-avatar h${hue}${zolt ? " bot-avatar-zolt" : ""} bot-avatar-${size}`}
      data-state={state}
      aria-hidden="true"
      style={{ "--bot-delay": `${hue * 75}ms` } as CSSProperties}
    >
      <svg viewBox="0 0 32 32" focusable="false" aria-hidden="true">
        <g className="bot-body">
          <path
            className="bot-silhouette"
            d={zolt ? "M13 3h9l-3 6h7v16l-5 4H9l-4-4V9h7Z" : bodies[(hue - 1) % bodies.length]}
          />
          <g className="bot-eyes">
            <rect x="10" y="14" width="3" height="4" rx="1" />
            <rect x="19" y="14" width="3" height="4" rx="1" />
          </g>
          <path
            className="bot-mouth"
            d={state === "failed" || state === "error" ? "M13 23q3-4 6 0" : "M13 21q3 4 6 0"}
          />
        </g>
      </svg>
    </span>
  );
}
