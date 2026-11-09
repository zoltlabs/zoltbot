import Svg, { Path, Rect } from "react-native-svg";

// Stroke icons drawn from the mockups, one path string each.
export const icons = {
  overview: "M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1Z",
  tasks: "m3 17 2 2 4-4 M3 7l2 2 4-4 M13 6h8 M13 12h8 M13 18h8",
  plus: "M12 5v14 M5 12h14",
  chats: "M7.9 20A9 9 0 1 0 4 16.1L2 22Z",
  settings: "M4 21v-7 M4 10V3 M12 21v-9 M12 8V3 M20 21v-5 M20 12V3 M2 14h4 M10 8h4 M18 16h4",
  back: "m15 18-6-6 6-6",
  chevron: "m9 18 6-6-6-6",
  down: "m6 9 6 6 6-6",
  check: "M20 6 9 17l-5-5",
  spinner: "M21 12a9 9 0 1 1-6.2-8.6",
  folder:
    "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z",
  lock: "M8 11V7a4 4 0 0 1 8 0v4 M6 11h12a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2Z",
  newChat: "M7.9 20A9 9 0 1 0 4 16.1L2 22Z M12 8v8 M8 12h8",
  newTask: "m3 7 2 2 4-4 M3 17l2 2 4-4 M13 7h8 M13 17h4 M19 15v4 M17 17h4",
  task: "M9 6h11 M9 12h11 M9 18h11 M4 6h.01 M4 12h.01 M4 18h.01",
  attach:
    "M21.4 11.1 12.2 20.3a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5",
  send: "M12 19V5 M5 12l7-7 7 7",
  fork: "M6 3v12 M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M18 9a9 9 0 0 1-9 9",
  bell: "M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9 M10.3 21a1.94 1.94 0 0 0 3.4 0",
  spark: "M12 3l1.9 5.6L19.5 10.5l-5.6 1.9L12 18l-1.9-5.6L4.5 10.5l5.6-1.9Z",
  offline:
    "M2 2l20 20 M8.5 16.5a5 5 0 0 1 7 0 M5 12.9a10 10 0 0 1 5.2-2.8 M19 12.9a10 10 0 0 0-2.3-1.6 M12 20h.01",
} as const;
export type IconName = keyof typeof icons;

export function Icon({
  name,
  size = 24,
  color,
  stroke = 1.6,
}: {
  name: IconName;
  size?: number;
  color: string;
  stroke?: number;
}) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      accessible={false}
      pointerEvents="none"
    >
      <Path
        d={icons[name]}
        stroke={color}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

export function StopGlyph({ color }: { color: string }) {
  return (
    <Svg width={14} height={14} viewBox="0 0 14 14" accessible={false} pointerEvents="none">
      <Rect width={14} height={14} rx={3} fill={color} />
    </Svg>
  );
}

/** The Zoltbot mark from the mockups. Its colors are the brand's own, the same in both themes. */
export function Logo({ size = 56 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 32 32" accessibilityLabel="Zoltbot" role="img">
      <Rect width={32} height={32} rx={8} fill="#20211E" />
      <Path d="M7 7h18v5H7z M7 21h18v5H7z" fill="#FFBE3D" />
      <Path d="M17.5 12H25L14.5 21H7z" fill="#B77A18" />
    </Svg>
  );
}
