// P7: reads and changes the Home Screen icon through the ZoltIcon module (iOS dev builds only).
import { NativeModules, Platform } from "react-native";
import { create } from "zustand";
import { type AppIconChoice, appIconFor } from "../data/app-icons";

interface IconBridge {
  current(): Promise<string | null>;
  choose(name: string | null): Promise<void>;
}
const bridge =
  Platform.OS === "ios" ? (NativeModules.ZoltIcon as IconBridge | undefined) : undefined;
export const appIconAvailable = Boolean(bridge);

export const useAppIcon = create<{
  current: AppIconChoice;
  refresh(): Promise<void>;
  choose(icon: AppIconChoice): Promise<"ok" | { reason: string }>;
}>((set) => ({
  current: appIconFor(null),
  async refresh() {
    if (!bridge) return;
    const name = await bridge.current().catch(() => null);
    set({ current: appIconFor(name) });
  },
  async choose(icon) {
    if (!bridge) return { reason: "This build can't change the app icon." };
    try {
      await bridge.choose(icon.native);
      set({ current: icon });
      return "ok";
    } catch (error) {
      return { reason: error instanceof Error && error.message ? error.message : "Try again." };
    }
  },
}));
