import * as Notifications from "expo-notifications";
import { create } from "zustand";
import { inspectPush } from "../data/push";

interface PushState {
  label: string;
  token?: string | undefined;
  busy: boolean;
  refresh(ask?: boolean): Promise<void>;
}
/** Token stays on the phone until a registration contract exists. */
export const usePush = create<PushState>((set, get) => ({
  label: "Not requested",
  busy: false,
  async refresh(ask = false) {
    if (get().busy) return;
    set({ busy: true });
    try {
      const { permission, token } = await inspectPush(Notifications, ask);
      set({
        token,
        label: permission.granted ? "Allowed" : permission.canAskAgain ? "Not requested" : "Denied",
      });
    } catch {
      set({ label: "Unavailable" });
    } finally {
      set({ busy: false });
    }
  },
}));
