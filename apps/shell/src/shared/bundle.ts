// D7: move to another computer. Agents, memory, skills, routines, the company and settings go
// to a ZIP; chats, saved logins and connection sign-ins stay on this Mac.

export const BUNDLE_CHANNELS = {
  export: "bundle:export",
  preview: "bundle:preview",
  apply: "bundle:apply",
} as const;

export interface BundlePreviewItem {
  id: string;
  kind: string;
  name: string;
  action: "add" | "replace";
}

export interface BundlePreview {
  previewId: string;
  agents: number;
  items: BundlePreviewItem[];
  /** Connections to sign in to again here. */
  connections: string[];
  /** Coding tools to set up here first; agents that use them are left out until then. */
  tools: string[];
}

export interface BundleDesktopApi {
  /** Asks where to save, then writes the export. False when the owner cancelled. */
  export: () => Promise<{ saved: boolean }>;
  /** Asks for an export file and previews it. Null when the owner cancelled. */
  preview: () => Promise<BundlePreview | null>;
  apply: (input: { previewId: string; selected: string[] }) => Promise<void>;
}
