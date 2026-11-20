import type {
  AttachmentSummary,
  BotAvatarColor,
  BotAvatarShape,
  BrowserControlAction,
  DraftAttachment,
} from "../../../../shared/ipc";

export interface ComposerDraft {
  text: string;
  attachments: DraftAttachment[];
  replyToMessageId: string | null;
}

export interface MediaPreview {
  attachment: AttachmentSummary;
  text: string | null;
  loading: boolean;
  error: string | null;
}

export type RightPanelMode = "none" | "browser" | "settings" | "organization" | "artifact";

export const EMPTY_DRAFT: ComposerDraft = { text: "", attachments: [], replyToMessageId: null };
export const ONBOARDING_CHOICES = [
  "Work & projects",
  "Research & writing",
  "Sales & outreach",
  "Something else",
];
export const SETTINGS_PANEL_STORAGE_KEY = "openbot:settings-panel-width";
export const SETTINGS_PANEL_DEFAULT = 296;
export const SETTINGS_PANEL_MIN = 180;
export const SETTINGS_PANEL_MAX = 1600;
export const BROWSER_PANEL_STORAGE_KEY = "openbot:browser-panel-width";
export const BROWSER_PANEL_DEFAULT = 380;
export const BROWSER_PANEL_MIN = 220;
export const BROWSER_PANEL_MAX = 1600;
export const ARTIFACT_PANEL_STORAGE_KEY = "zoltbot:artifact-panel-width";
export const CONVERSATION_PANEL_MIN = 96;

export const BROWSER_ACTION_LABELS: Record<BrowserControlAction, string> = {
  open: "Opening a page…",
  "list-tabs": "Checking tabs…",
  snapshot: "Reading the page…",
  click: "Clicking…",
  type: "Typing…",
  key: "Using the keyboard…",
  scroll: "Scrolling…",
  back: "Going back…",
  forward: "Going forward…",
  reload: "Reloading…",
  screenshot: "Taking a screenshot…",
  "close-tab": "Closing a tab…",
};

export const AVATAR_COLOR_LABELS: Record<BotAvatarColor, string> = {
  black: "Black",
  brown: "Brown",
  red: "Red",
  orange: "Orange",
  yellow: "Yellow",
  green: "Green",
  cyan: "Cyan",
  blue: "Blue",
  violet: "Violet",
  magenta: "Magenta",
  gray: "Gray",
};

export const AVATAR_SHAPE_LABELS: Record<BotAvatarShape, string> = {
  blob: "blob",
  pebble: "pebble",
  squircle: "squircle",
  tablet: "tablet",
  wedge: "wedge",
  hex: "hex",
  cloud: "cloud",
  teardrop: "teardrop",
};
