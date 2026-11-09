import { terms } from "@zoltbot/protocol";
import { create } from "zustand";
import { needsOnboarding } from "./setup/onboarding-state.js";
import type { WorkspaceScope } from "./workspaces/view.js";
export const routes = ["Overview", "Inbox", "Tasks", "Routines", "Projects", "Sessions"] as const;
/** Inbox is labelled "Needs you" in the sidebar, and Projects "Workspaces". */
export const navRoutes = ["Overview", "Inbox", "Tasks", "Routines"] as const;
export const routeLabels: Partial<Record<Route, string>> = {
  Inbox: "Needs you",
  Projects: terms.workspace.Many,
  Sessions: "All chats",
  Doctor: "Settings",
  Connections: "Settings",
  Rules: "Settings",
};
export type Route =
  | (typeof routes)[number]
  | "Rules"
  | "Settings"
  | "Connections"
  | "Doctor"
  | "Setup"
  | "Components"
  | "Chat"
  | "Artifact"
  | "QuickChat"
  | "Chief"
  | "Compare";
export type Theme = "light" | "dark" | "system";
function storedTheme(): Theme {
  try {
    const value = localStorage.getItem("zoltbot.theme.v1");
    if (value === "light" || value === "dark" || value === "system") return value;
  } catch {}
  return "dark";
}
export const defaultFontScale = 115;
export function normalizeFontScale(value: number): number {
  return Number.isFinite(value)
    ? Math.max(100, Math.min(150, Math.round(value / 5) * 5))
    : defaultFontScale;
}
function storedFontScale(): number {
  try {
    const value = localStorage.getItem("zoltbot.fontScale.v1");
    if (value !== null) return normalizeFontScale(Number(value));
  } catch {}
  return defaultFontScale;
}
export const useShell = create<{
  compareId: string | undefined;
  openCompare(id: string): void;
  /** The open Quick Chat; undefined is a fresh composer that creates nothing until sent. */
  quickChatId: string | undefined;
  openQuickChat(id?: string): void;
  /** A reviewable brief from a Quick Chat handoff, placed in that chat's composer once. */
  chatDraft: { threadId: string; text: string } | undefined;
  clearChatDraft(threadId: string): void;
  designTaskDraft: { requestId: string; brief: string; projectId?: string } | undefined;
  startDesignTask(brief: string, projectId?: string): void;
  clearDesignTask(): void;
  artifactId: string | undefined;
  openArtifact(id: string): void;
  shippingTaskId: string | undefined;
  openShipping(id: string): void;
  closeShipping(): void;
  route: Route;
  threadId: string | undefined;
  /** The request the Inbox opens on, when it was opened from the Overview. */
  requestId: string | undefined;
  openRequest: (id: string) => void;
  scope: WorkspaceScope | undefined;
  openScope: (scope: WorkspaceScope) => void;
  openThread: (id: string) => void;
  theme: Theme;
  fontScale: number;
  setFontScale: (scale: number) => void;
  palette: boolean;
  sidebar: boolean;
  width: number;
  navigate: (route: Route) => void;
  setTheme: (theme: Theme) => void;
  setPalette: (open: boolean) => void;
  toggleSidebar: () => void;
  setWidth: (width: number) => void;
}>((set, get) => ({
  compareId: undefined,
  openCompare: (id) => {
    location.hash = `compare/${encodeURIComponent(id)}`;
    set({ route: "Compare", compareId: id, palette: false });
  },
  quickChatId: undefined,
  openQuickChat: (id) => {
    location.hash = id ? `quick/${encodeURIComponent(id)}` : "quick";
    set({ route: "QuickChat", quickChatId: id, palette: false });
  },
  chatDraft: undefined,
  clearChatDraft: (threadId) => {
    if (get().chatDraft?.threadId === threadId) set({ chatDraft: undefined });
  },
  designTaskDraft: undefined,
  startDesignTask: (brief, projectId) => {
    location.hash = "tasks";
    set({
      route: "Tasks",
      designTaskDraft: {
        requestId: crypto.randomUUID(),
        brief,
        ...(projectId ? { projectId } : {}),
      },
      ...(projectId ? { scope: { type: "project", id: projectId } } : {}),
      palette: false,
    });
  },
  clearDesignTask: () => set({ designTaskDraft: undefined }),
  artifactId: undefined,
  openArtifact: (id) => {
    location.hash = `artifact/${encodeURIComponent(id)}`;
    set({ route: "Artifact", artifactId: id, palette: false });
  },
  shippingTaskId: undefined,
  openShipping: (id) => {
    location.hash = `tasks/${encodeURIComponent(id)}/shipping`;
    set({ route: "Tasks", shippingTaskId: id });
  },
  closeShipping: () => {
    location.hash = "tasks";
    set({ shippingTaskId: undefined });
  },
  route:
    typeof location !== "undefined" && !location.hash.slice(1) && needsOnboarding()
      ? "Setup"
      : "Overview",
  threadId: undefined,
  requestId: undefined,
  openRequest: (id) => {
    location.hash = "inbox";
    set({ route: "Inbox", requestId: id, palette: false });
  },
  scope: undefined,
  openScope: (scope) => {
    location.hash = `projects/${scope.type}/${encodeURIComponent(scope.id)}`;
    set({ route: "Projects", scope, palette: false });
  },
  openThread: (id) => {
    location.hash = `chat/${encodeURIComponent(id)}`;
    set({ route: "Chat", threadId: id, palette: false });
  },
  theme: storedTheme(),
  fontScale: storedFontScale(),
  setFontScale: (value) => {
    const fontScale = normalizeFontScale(value);
    try {
      localStorage.setItem("zoltbot.fontScale.v1", String(fontScale));
    } catch {}
    set({ fontScale });
  },
  palette: false,
  sidebar: true,
  width: 240,
  navigate: (route) => {
    location.hash = route.toLowerCase();
    // The hash listener re-navigates to the current route, so keep the request it opened on.
    set((s) => ({
      route,
      shippingTaskId: undefined,
      requestId: s.route === route ? s.requestId : undefined,
      palette: false,
    }));
  },
  setTheme: (theme) => {
    try {
      localStorage.setItem("zoltbot.theme.v1", theme);
    } catch {}
    set({ theme });
  },
  setPalette: (palette) => set({ palette }),
  toggleSidebar: () => set((s) => ({ sidebar: !s.sidebar })),
  setWidth: (width) => set({ width: Math.max(220, Math.min(360, width)) }),
}));
