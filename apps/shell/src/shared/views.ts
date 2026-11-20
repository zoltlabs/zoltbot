export const VIEW_PERMISSIONS = ["read", "act", "approve"] as const;
export type ViewPermission = (typeof VIEW_PERMISSIONS)[number];

/** A key a view declares in its manifest; the shell forwards it while the view is open. */
export interface ViewShortcut {
  id: string;
  keys: string;
  label: string;
}

/** An installed Zoltbot view, as the shell shows it. */
export interface ViewSummary {
  id: string;
  name: string;
  enabled: boolean;
  /** The view may read chats; without it the view isn't loaded. */
  canRead: boolean;
  /** What the view's manifest asks for, in manifest order. */
  requested: ViewPermission[];
  granted: ViewPermission[];
  /** Requested permissions the person hasn't granted or turned down yet. */
  pending: ViewPermission[];
  shortcuts: ViewShortcut[];
  error: string | null;
}

/** The look a view copies from the shell, matching the view API's theme message. */
export interface ViewTheme {
  scheme: "light" | "dark";
  tokens: Record<string, string>;
  fontSans: string;
  fontMono: string;
  fontScale: number;
}

export interface ViewConnectInput {
  viewId: string;
  theme: ViewTheme;
  locale: string;
  reducedMotion: boolean;
}

export interface ViewUpdateInput {
  sessionId: string;
  visible?: boolean;
  theme?: ViewTheme;
}

export type ViewHostEvent =
  | { type: "views-changed" }
  /** A message main sends to the view's frame. */
  | { type: "message"; sessionId: string; message: unknown }
  | { type: "closed"; sessionId: string; failed: boolean }
  /** The view asked to open a chat, or another page when `chatId` is null. */
  | { type: "open"; chatId: string | null }
  | { type: "key"; combo: string };

export interface ViewsDesktopApi {
  getMap: () => Promise<ViewSummary | null>;
  /** Replaces the view's grants with `permissions`, which must be ones it requested. */
  setGrants: (viewId: string, permissions: ViewPermission[]) => Promise<void>;
  turnOn: (viewId: string) => Promise<void>;
  prepare: (viewId: string) => Promise<{ url: string }>;
  connect: (input: ViewConnectInput) => Promise<{ sessionId: string }>;
  /** Relays a message from the view's frame to main, which validates it. */
  post: (sessionId: string, message: unknown) => void;
  update: (input: ViewUpdateInput) => void;
  close: (sessionId: string) => void;
  /** Runs one of the view's own shortcuts, pressed while focus is outside its frame. */
  shortcut: (sessionId: string, shortcutId: string) => void;
  onEvent: (listener: (event: ViewHostEvent) => void) => () => void;
}
