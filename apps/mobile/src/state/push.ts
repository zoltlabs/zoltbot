import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { create } from "zustand";
import { inspectPush, type PushPlatform } from "../data/push";

interface PushState {
  label: string;
  token?: string | undefined;
  platform?: PushPlatform | undefined;
  busy: boolean;
  refresh(ask?: boolean): Promise<void>;
}
/** The phone's push token; state/push-registration.ts gives it to each paired Mac's relay. */
export const usePush = create<PushState>((set, get) => ({
  label: "Not requested",
  busy: false,
  async refresh(ask = false) {
    if (get().busy) return;
    set({ busy: true });
    try {
      // Android shows notifications only through a channel; FCM pushes name this one.
      if (Platform.OS === "android")
        await Notifications.setNotificationChannelAsync("default", {
          name: "Zoltbot",
          importance: Notifications.AndroidImportance.HIGH,
        }).catch(() => undefined);
      const { permission, token, platform } = await inspectPush(Notifications, ask, __DEV__);
      set({
        token,
        platform,
        label: permission.granted ? "Allowed" : permission.canAskAgain ? "Not requested" : "Denied",
      });
    } catch {
      set({ label: "Unavailable" });
    } finally {
      set({ busy: false });
    }
  },
}));
