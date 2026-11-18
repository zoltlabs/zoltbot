import type { CSSProperties } from "react";
import { botSilhouette } from "./bot-avatar-shapes.js";
import { avatarHue, useProfileHue } from "./identity.js";
import "./bot-avatar.css";

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
          <path className="bot-silhouette" d={botSilhouette(hue, zolt)} />
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
